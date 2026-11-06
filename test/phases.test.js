'use strict';
// Phase 1 (check in / sit out), phase 2 (gift reminders), Do not disturb,
// guidelines, and the database upgrade that added them. Runs in demo mode so
// anyone can sign in with the demo code; emails land in the outbox.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { startApp } = require('./helpers');
const { openDb, MIGRATIONS } = require('../server/db');
const { addDays, today } = require('../server/lib/util');

test('a version-1 database upgrades in place', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'santa-mig-')), 'old.sqlite');
  const raw = new DatabaseSync(file);
  raw.exec(MIGRATIONS[0]);
  raw.exec('PRAGMA user_version = 1');
  raw.exec("INSERT INTO teams (name, start_date, end_date, created_at, updated_at) VALUES ('Old', '2026-12-01', '2026-12-24', 'x', 'x')");
  raw.close();
  const db = openDb(file);
  assert.equal(db.get('PRAGMA user_version').user_version, MIGRATIONS.length);
  const t = db.get("SELECT * FROM teams WHERE name = 'Old'");
  assert.equal(t.reminder_days, '3,1');
  assert.equal(t.location_deadline, null);
  assert.equal(t.guidelines, '');
  assert.ok(db.get("SELECT 1 FROM sqlite_master WHERE name = 'reminders_sent'"));
  db.close();
});

let env;
let admin;
let organiser;
let teamId;
const ids = {};

async function signIn(email) {
  const c = await env.client().init();
  await c.post('/api/auth/otp/request', { email });
  const r = await c.post('/api/auth/otp/verify', { email, code: '123456' });
  assert.equal(r.status, 200, r.text);
  return c;
}
const outbox = async () => env.app.db.all('SELECT id, to_email AS "to", subject, kind FROM outbox ORDER BY id DESC');
const mailBody = (mailId) => env.app.db.get('SELECT html FROM outbox WHERE id = ?', mailId).html;

test.before(async () => {
  env = await startApp({ SANTA_DEMO_MODE: 'true', SANTA_BASE_URL: 'https://santa.example.com' });
  admin = await env.client().init();
  await admin.post('/api/auth/password', { username: 'admin', password: 'admin' });
  // our own little world inside the demo database
  const loc = (await admin.get('/api/locations')).body.find((l) => l.name === 'North Pole').id;
  for (const n of ['Ann', 'Ben', 'Cat', 'Dan', 'Eve']) {
    const r = await admin.post('/api/admin/users', { username: `${n} Test`, externalId: `T-${n}`, email: `${n.toLowerCase()}@test.example`, locationId: loc });
    assert.equal(r.status, 200, r.text);
    ids[n] = r.body.id;
  }
  assert.equal((await admin.post('/api/admin/users', { username: 'Odin Organiser', externalId: 'T-Odin', email: 'odin@test.example', locationId: loc })).status, 200);
  organiser = await signIn('odin@test.example');
  const t = await organiser.post('/api/manage/teams', {
    name: 'Phase Test', startDate: addDays(today(), 5), endDate: addDays(today(), 20), locationDeadline: addDays(today(), 1),
    reminderDays: '3, 1', guidelines: '- Be kind\n- **Have fun**',
  });
  assert.equal(t.status, 200, t.text);
  teamId = t.body.id;
  await organiser.post(`/api/manage/teams/${teamId}/members`, { userIds: Object.values(ids) });
});
test.after(() => env.close());

test('phase 1: players check in, and the admin sees who has', async () => {
  const ann = await signIn('ann@test.example');
  let v = (await ann.get(`/api/teams/${teamId}`)).body;
  assert.equal(v.checkIn.open, true);
  assert.equal(v.me.confirmedAt, null);
  const mine = (await ann.get('/api/me/teams')).body.teams.find((t) => t.id === teamId);
  assert.equal(mine.needsCheckIn, true);
  v = (await ann.put(`/api/teams/${teamId}/location`, { locationId: null })).body;
  assert.ok(v.me.confirmedAt, 'confirming the profile location counts as checking in');
  const d = (await organiser.get(`/api/manage/teams/${teamId}`)).body;
  assert.equal(d.checkIn.confirmed, 1);
  assert.equal(d.checkIn.total, 5);
  assert.equal(d.team.reminderDays, '3,1');
  const bad = await organiser.put(`/api/manage/teams/${teamId}`, { ...d.team, reminderDays: 'soon' });
  assert.equal(bad.status, 400);
});

test('sitting out: before the draw only, never drawn, never emailed', async () => {
  const dan = await signIn('dan@test.example');
  let v = (await dan.post(`/api/teams/${teamId}/sit-out`, { out: true })).body;
  assert.equal(v.me.optedOut, true);
  assert.equal(v.members.some((m) => m.id === ids.Dan), false, 'not listed among the players');
  const loc = await dan.put(`/api/teams/${teamId}/location`, {});
  assert.equal(loc.status, 409, 'cannot check in while sitting out');
  let d = (await organiser.get(`/api/manage/teams/${teamId}`)).body;
  assert.deepEqual(d.sittingOut, [ids.Dan]);
  assert.equal(d.pools.reduce((n, p) => n + p.count, 0), 4, 'not in the location balance');
  // back in, and out again
  v = (await dan.post(`/api/teams/${teamId}/sit-out`, { out: false })).body;
  assert.equal(v.me.optedOut, false);
  await dan.post(`/api/teams/${teamId}/sit-out`, { out: true });
  d = (await organiser.get(`/api/manage/teams/${teamId}`)).body;
  assert.equal(d.audience.location.total, 3, 'Ben, Cat and Eve still need to check in; Dan is sitting out');
});

test('do not disturb: no emails at all', async () => {
  const eve = await signIn('eve@test.example');
  const r = await eve.put('/api/me', { dnd: true });
  assert.equal(r.body.dnd, true);
  const d = (await organiser.get(`/api/manage/teams/${teamId}`)).body;
  assert.equal(d.audience.location.reachable, 2, 'Eve is on do not disturb');
  assert.equal((await admin.get('/api/admin/users')).body.find((u) => u.id === ids.Eve).dnd, true);
});

test('automatic check-in reminder: the right people, once per round', async () => {
  env.app.tick();
  let mails = (await outbox()).filter((m) => m.kind === 'locationReminder' && m.subject.includes('Phase Test'));
  assert.deepEqual(mails.map((m) => m.to).sort(), ['ben@test.example', 'cat@test.example']);
  assert.ok(mails.every((m) => !/must|overdue|final warning|last chance/i.test(m.subject)), 'soft wording');
  env.app.tick();
  mails = (await outbox()).filter((m) => m.kind === 'locationReminder' && m.subject.includes('Phase Test'));
  assert.equal(mails.length, 2, 'not sent twice');
  const d = (await organiser.get(`/api/manage/teams/${teamId}`)).body;
  assert.equal(d.reminders.length, 1);
  assert.equal(d.reminders[0].offset, 1);
  // a manual nudge is always possible and logged separately
  const n = await organiser.post(`/api/manage/teams/${teamId}/remind`, { kind: 'location' });
  assert.equal(n.body.mailed, 2);
  assert.equal(n.body.detail.reminders.length, 2);
  // the email itself says opting out is fine, and links to do not disturb
  const html = mailBody(mails[0].id);
  assert.match(html, /Sit this one out/);
  assert.match(html, /Do not disturb/);
});

test('after check-in closes, locations are locked for players', async () => {
  const d = (await organiser.get(`/api/manage/teams/${teamId}`)).body;
  await organiser.put(`/api/manage/teams/${teamId}`, { ...d.team, locationDeadline: addDays(today(), -1) });
  const ben = await signIn('ben@test.example');
  const r = await ben.put(`/api/teams/${teamId}/location`, {});
  assert.equal(r.status, 409);
  assert.match(r.body.error, /Check-in closed/);
  // the organiser setting it counts as checking in
  const loc = (await admin.get('/api/locations')).body[0].id;
  const after = (await organiser.put(`/api/manage/teams/${teamId}/members/${ids.Ben}`, { locationId: loc })).body;
  assert.ok(after.members.find((m) => m.id === ids.Ben).confirmedAt);
});

test('the draw leaves out whoever sits out; afterwards nobody can opt out alone', async () => {
  const d = (await organiser.get(`/api/manage/teams/${teamId}`)).body;
  await organiser.put(`/api/manage/teams/${teamId}`, { ...d.team, matchScope: 'all' });
  const r = await organiser.post(`/api/manage/teams/${teamId}/draw`, {});
  assert.equal(r.status, 200, r.text);
  const m = (await organiser.get(`/api/manage/teams/${teamId}/matches`)).body;
  assert.equal(m.length, 4);
  assert.ok(!m.some((x) => x.santaId === ids.Dan || x.childId === ids.Dan));
  const ann = await signIn('ann@test.example');
  const late = await ann.post(`/api/teams/${teamId}/sit-out`, { out: true });
  assert.equal(late.status, 409);
  const ins = await organiser.post(`/api/manage/teams/${teamId}/members/${ids.Dan}/insert`, {});
  assert.equal(ins.status, 409, 'someone sitting out is not slotted in');
});

test('phase 2: a friendly jingle to Santas without a final gift, before the end', async () => {
  const d = (await organiser.get(`/api/manage/teams/${teamId}`)).body;
  // make the game live and ending tomorrow
  await organiser.put(`/api/manage/teams/${teamId}`, { ...d.team, startDate: addDays(today(), -3), endDate: addDays(today(), 1), locationDeadline: '' });
  const m = (await organiser.get(`/api/manage/teams/${teamId}/matches`)).body;
  const annChild = m.find((x) => x.santaId === ids.Ann);
  const ann = await signIn('ann@test.example');
  const g = await ann.post(`/api/teams/${teamId}/gifts`, { description: 'A scarf', isFinal: true });
  assert.equal(g.status, 200, g.text);
  assert.ok(annChild);
  env.app.tick();
  const mails = (await outbox()).filter((x) => x.kind === 'giftReminder' && x.subject.includes('Phase Test'));
  const to = mails.map((x) => x.to).sort();
  assert.ok(!to.includes('ann@test.example'), 'Ann already logged her final gift');
  assert.ok(!to.includes('eve@test.example'), 'Eve is on do not disturb');
  assert.ok(to.length >= 1);
  const html = mailBody(mails[0].id);
  assert.match(html, /no stress at all/);
  env.app.tick();
  assert.equal((await outbox()).filter((x) => x.kind === 'giftReminder' && x.subject.includes('Phase Test')).length, mails.length, 'once per round');
});

test('guidelines: set by the admin, shown to players with each team\'s rules', async () => {
  const s = await admin.put('/api/admin/settings/guidelines', { text: '# Our rules\n- Kindness first' });
  assert.equal(s.status, 200);
  const ann = await signIn('ann@test.example');
  const g = (await ann.get('/api/guide')).body;
  assert.equal(g.text, '# Our rules\n- Kindness first');
  const mine = g.teams.find((t) => t.id === teamId);
  assert.equal(mine.guidelines, '- Be kind\n- **Have fun**');
  const players = await ann.put('/api/admin/settings/guidelines', { text: 'hacked' });
  assert.equal(players.status, 403);
});
