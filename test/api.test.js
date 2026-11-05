'use strict';
// End-to-end through the HTTP API with real data (demo mode off), a fake mail
// relay catching the actual sign-in codes.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, fakeSmtp, waitFor } = require('./helpers');
const { addDays, today } = require('../server/lib/util');
const { isValidDraw } = require('../server/lib/matching');

const CSV = [
  'userName,ID,email,location',
  'Holly Berry,E1,holly@example.com,North Pole',
  'Jack Frost,E2,jack@example.com,North Pole',
  'Noelle Winters,E3,noelle@example.com,North Pole',
  'Nick Kringle,E4,nick@example.com,North Pole',
  'Carol Singer,E5,carol@example.com,Gingerbread Town',
  'Buddy Elfson,E6,buddy@example.com,Gingerbread Town',
  'Ginger Snap,E7,ginger@example.com,Gingerbread Town',
  'Comet Starling,E8,comet@example.com,Snowglobe City',
  'Bad Row,,not-an-email,North Pole',
].join('\n');

let env;
let smtp;
let admin;

async function signInWithCode(email) {
  const c = await env.client().init();
  const before = smtp.messages.length;
  const r = await c.post('/api/auth/otp/request', { email });
  assert.equal(r.status, 200, r.text);
  const msg = await waitFor(() => smtp.messages.slice(before).find((m) => m.rcpt.join().includes(email) && /\d{6} is your/.test(m.data)));
  const code = /(\d{6}) is your/.exec(msg.data)[1];
  const v = await c.post('/api/auth/otp/verify', { email, code });
  assert.equal(v.status, 200, v.text);
  return c;
}

test.before(async () => {
  smtp = await fakeSmtp();
  env = await startApp({ SANTA_BASE_URL: 'https://santa.example.com' });
});
test.after(async () => {
  await env.close();
  await smtp.close();
});

test('the seeded admin / admin must choose a new password first', async () => {
  admin = await env.client().init();
  const bad = await admin.post('/api/auth/password', { username: 'admin', password: 'nope' });
  assert.equal(bad.status, 401);
  const r = await admin.post('/api/auth/password', { username: 'admin', password: 'admin' });
  assert.equal(r.status, 200);
  assert.equal(r.body.user.mustChangePassword, true);
  const blocked = await admin.get('/api/admin/overview');
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.details.code, 'password_change_required');
  const weak = await admin.post('/api/auth/change-password', { current: 'admin', next: 'admin' });
  assert.equal(weak.status, 400);
  const ok = await admin.post('/api/auth/change-password', { current: 'admin', next: 'Sleigh-Bells-2026' });
  assert.equal(ok.status, 200);
  assert.equal((await admin.get('/api/admin/overview')).status, 200);
});

test('state-changing requests need the CSRF token', async () => {
  const r = await admin.req('POST', '/api/admin/locations', { name: 'Nowhere' }, { csrf: false });
  assert.equal(r.status, 403);
});

test('the mail relay is configured by the admin and tested', async () => {
  const r = await admin.put('/api/admin/settings/email', { host: '127.0.0.1', port: smtp.port, security: 'none', fromName: 'Secret Santa', fromEmail: 'santa@example.com' });
  assert.equal(r.status, 200, r.text);
  const t = await admin.post('/api/admin/settings/email/test', { to: 'organiser@example.com' });
  assert.equal(t.body.ok, true, t.text);
  assert.ok(smtp.messages.some((m) => m.data.includes('Jingle check')));
});

test('CSV import: preview first, then import; bad rows are skipped and reported', async () => {
  const p = await admin.post('/api/admin/users/import', { csv: CSV });
  assert.equal(p.status, 200, p.text);
  assert.equal(p.body.summary.create, 8);
  assert.equal(p.body.summary.error, 1);
  assert.deepEqual(p.body.newLocations.sort(), ['Gingerbread Town', 'North Pole', 'Snowglobe City']);
  const c = await admin.post('/api/admin/users/import', { csv: CSV, commit: true });
  assert.equal(c.body.summary.create, 8);
  assert.equal(c.body.skipped.length, 1);
  // importing again changes nothing
  const again = await admin.post('/api/admin/users/import', { csv: CSV });
  assert.equal(again.body.summary.unchanged, 8);
  const missing = await admin.post('/api/admin/users/import', { csv: 'name,email\nA,a@example.com' });
  assert.equal(missing.status, 400);
});

let teamId;
const ids = {};

test('team, players and the location balance', async () => {
  const users = (await admin.get('/api/admin/users')).body;
  for (const u of users) ids[u.username] = u.id;
  const t = await admin.post('/api/manage/teams', {
    name: 'Workshop Elves', startDate: addDays(today(), -1), endDate: addDays(today(), 10), budget: '$25', minGroupSize: 3,
  });
  assert.equal(t.status, 200, t.text);
  teamId = t.body.id;
  const players = Object.entries(ids).filter(([n]) => n !== 'admin').map(([, v]) => v);
  const add = await admin.post(`/api/manage/teams/${teamId}/members`, { userIds: players });
  assert.equal(add.body.added, 8);
  const pools = Object.fromEntries(add.body.detail.pools.map((p) => [p.label, p]));
  assert.equal(pools['Snowglobe City'].level, 'error', 'a location of one is highlighted');
  assert.equal(pools['North Pole'].level, 'ok');
  const blocked = await admin.post(`/api/manage/teams/${teamId}/draw`, {});
  assert.equal(blocked.status, 409, 'cannot draw with a one-person location');
  const locs = (await admin.get('/api/locations')).body;
  const gb = locs.find((l) => l.name === 'Gingerbread Town').id;
  const merged = await admin.post(`/api/manage/teams/${teamId}/pools/merge`, { fromPool: pools['Snowglobe City'].key, intoLocationId: gb });
  assert.equal(merged.status, 200, merged.text);
  assert.ok(merged.body.pools.every((p) => p.level === 'ok'));
});

test('exclusions and the draw: valid within each pool, Santas emailed', async () => {
  await admin.post(`/api/manage/teams/${teamId}/exclusions`, { a: ids['Holly Berry'], b: ids['Jack Frost'] });
  const before = smtp.messages.length;
  const d = await admin.post(`/api/manage/teams/${teamId}/draw`, { notify: true });
  assert.equal(d.status, 200, d.text);
  assert.equal(d.body.mailed, 8);
  const m = (await admin.get(`/api/manage/teams/${teamId}/matches`)).body;
  const pairs = m.map((x) => ({ santa: x.santaId, child: x.childId }));
  const np = ['Holly Berry', 'Jack Frost', 'Noelle Winters', 'Nick Kringle'].map((n) => ids[n]);
  const gb = ['Carol Singer', 'Buddy Elfson', 'Ginger Snap', 'Comet Starling'].map((n) => ids[n]);
  const isEx = (a, b) => [a, b].sort().join() === [ids['Holly Berry'], ids['Jack Frost']].sort().join();
  assert.ok(isValidDraw(np, pairs.filter((p) => np.includes(p.santa)), isEx));
  assert.ok(isValidDraw(gb, pairs.filter((p) => gb.includes(p.santa))));
  await waitFor(() => smtp.messages.length >= before + 8, { timeout: 8000 });
  assert.ok(smtp.messages.slice(before).some((x) => x.data.includes('Secret Santa for')));
  const audit = (await admin.get('/api/admin/audit')).body;
  assert.ok(audit.some((a) => a.action === 'looked at the full Santa list'));
  const again = await admin.post(`/api/manage/teams/${teamId}/draw`, {});
  assert.equal(again.status, 409, 'a redraw needs confirming');
});

let holly;
let hollyChild;

test('sign-in by emailed code; the outbox keeps the code blanked out', async () => {
  holly = await signInWithCode('holly@example.com');
  const me = await holly.get('/api/me');
  assert.equal(me.body.name, 'Holly Berry');
  const box = (await admin.get('/api/admin/outbox')).body.rows.find((r) => r.kind === 'otp');
  const html = (await admin.get(`/api/admin/outbox/${box.id}/html`)).text;
  assert.ok(!/\d{3} \d{3}/.test(html.replace(/#[0-9a-f]{6}/gi, '')), 'no code in the stored copy');
  assert.ok(html.includes('••• •••'));
  // wrong codes are counted and refused
  const c = await env.client().init();
  await c.post('/api/auth/otp/request', { email: 'jack@example.com' }).catch(() => {});
  const wrong = await c.post('/api/auth/otp/verify', { email: 'jack@example.com', code: '000000' });
  assert.equal(wrong.status, 401);
  // unknown addresses get the same answer and no email
  const n = smtp.messages.length;
  const unknown = await c.post('/api/auth/otp/request', { email: 'stranger@example.com' });
  assert.equal(unknown.status, 200);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(smtp.messages.length, n);
});

test('a player sees their child and wishlist, never their own Santa', async () => {
  const v = (await holly.get(`/api/teams/${teamId}`)).body;
  assert.ok(v.child && v.child.name, 'has a child');
  hollyChild = v.child.id;
  assert.notEqual(v.child.id, ids['Jack Frost'], 'exclusion honoured');
  assert.equal(v.fromSanta.hasSanta, true);
  assert.equal(v.fromSanta.santaName, null);
  assert.equal(JSON.stringify(v.fromSanta).includes('santa_id'), false);
  // other people's wishlists are not reachable through the API
  const other = await holly.get(`/api/teams/${teamId + 999}`);
  assert.equal(other.status, 404);
  assert.equal((await holly.get('/api/admin/users')).status, 403);
});

test('wishlist links: only http(s) is accepted', async () => {
  const bad = await holly.post('/api/me/wishlist', { title: 'Evil', url: 'javascript:alert(1)' });
  assert.equal(bad.status, 400);
  const ok = await holly.post('/api/me/wishlist', { title: 'Socks', url: 'shop.example.com/socks', priority: 1 });
  assert.equal(ok.status, 200);
  assert.equal(ok.body[0].url, 'https://shop.example.com/socks');
});

test('gifts: many small ones and one final; the child is told, anonymously', async () => {
  const before = smtp.messages.length;
  let r = await holly.post(`/api/teams/${teamId}/gifts`, { description: 'Hot cocoa', isFinal: false });
  assert.equal(r.status, 200, r.text);
  r = await holly.post(`/api/teams/${teamId}/gifts`, { description: 'Scarf', isFinal: true });
  r = await holly.post(`/api/teams/${teamId}/gifts`, { description: 'Board game', isFinal: true });
  const finals = r.body.child.giftsGiven.filter((g) => g.isFinal);
  assert.equal(r.body.child.giftsGiven.length, 3);
  assert.deepEqual(finals.map((g) => g.description), ['Board game'], 'only one final gift');
  await waitFor(() => smtp.messages.length >= before + 3, { timeout: 8000 });
  const toChild = smtp.messages.slice(before).filter((m) => m.data.includes('left you something') || m.data.includes('final'));
  assert.ok(toChild.length > 0);
  assert.ok(toChild.every((m) => !m.data.includes('Holly')), 'the email never names the Santa');
});

test('fun tasks are public on the board - without the Santa', async () => {
  const r = await holly.post(`/api/teams/${teamId}/tasks`, { title: 'Wear a festive hat', details: 'Jingle bells!' });
  assert.equal(r.status, 200, r.text);
  const childEmail = (await admin.get('/api/admin/users')).body.find((u) => u.id === hollyChild).email;
  const child = await signInWithCode(childEmail);
  const board = (await child.get(`/api/teams/${teamId}/board`)).body;
  assert.equal(board.length, 1);
  assert.equal(board[0].forMe, true);
  assert.equal('santaId' in board[0] || 'santa_id' in board[0], false);
  const view = (await child.get(`/api/teams/${teamId}`)).body;
  const task = view.fromSanta.tasks[0];
  const done = await child.post(`/api/teams/${teamId}/tasks/${task.id}/done`, { note: 'Done!' });
  assert.equal(done.body.fromSanta.tasks[0].status, 'done');
  // somebody else in the team can see and cheer it
  const thirdEmail = ['noelle@example.com', 'nick@example.com'].find((e) => e !== childEmail);
  const third = await signInWithCode(thirdEmail);
  const b3 = (await third.get(`/api/teams/${teamId}/board`)).body;
  assert.equal(b3.length, 1);
  const cheered = await third.post(`/api/teams/${teamId}/tasks/${b3[0].id}/cheer`);
  assert.equal(cheered.body[0].cheers, 1);
  // anonymous notes: the child's thread never says who the Santa is
  await holly.post(`/api/teams/${teamId}/messages/child`, { body: 'Tea or coffee?' });
  const thread = (await child.get(`/api/teams/${teamId}/messages/santa`)).body;
  assert.equal(thread.length, 1);
  assert.deepEqual(Object.keys(thread[0]).sort(), ['body', 'createdAt', 'id', 'mine']);
  // the child thanks the Santa for a gift
  const gifts = view.fromSanta.gifts;
  const thx = await child.post(`/api/teams/${teamId}/gifts/${gifts[0].id}/received`, { thanks: 'Thank you!' });
  assert.ok(thx.body.fromSanta.gifts[0].receivedAt);
  // the reveal
  await admin.post(`/api/manage/teams/${teamId}/reveal`, { revealed: true });
  const after = (await child.get(`/api/teams/${teamId}`)).body;
  assert.equal(after.fromSanta.santaName, 'Holly Berry');
});

test('outside the dates, gifts and tasks are closed', async () => {
  const t = await admin.post('/api/manage/teams', { name: 'Next Year', startDate: addDays(today(), 30), endDate: addDays(today(), 40) });
  const id = t.body.id;
  await admin.post(`/api/manage/teams/${id}/members`, { userIds: [ids['Holly Berry'], ids['Jack Frost'], ids['Noelle Winters']] });
  await admin.post(`/api/manage/teams/${id}/draw`, {});
  const r = await holly.post(`/api/teams/${id}/gifts`, { description: 'Too early' });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /opens on/);
});

test('late joiner goes into the circle; a dropout closes it again', async () => {
  const add = await admin.post('/api/admin/users', { username: 'Late Larry', externalId: 'E9', email: 'larry@example.com', locationId: (await admin.get('/api/locations')).body.find((l) => l.name === 'North Pole').id });
  assert.equal(add.status, 200, add.text);
  const larry = add.body.id;
  let d = (await admin.post(`/api/manage/teams/${teamId}/members`, { userIds: [larry] })).body.detail;
  assert.deepEqual(d.unmatched, [larry]);
  d = (await admin.post(`/api/manage/teams/${teamId}/members/${larry}/insert`, { notify: false })).body;
  assert.equal(d.unmatched.length, 0);
  const all = (await admin.get(`/api/manage/teams/${teamId}`)).body.members.map((m) => m.id);
  let pairs = (await admin.get(`/api/manage/teams/${teamId}/matches`)).body.map((x) => ({ santa: x.santaId, child: x.childId }));
  assert.ok(isValidDraw(all, pairs));
  // remove someone mid-game: still a valid draw over everyone left
  const gone = ids['Nick Kringle'];
  const r = await admin.del(`/api/manage/teams/${teamId}/members/${gone}`);
  assert.equal(r.status, 200, r.text);
  const left = r.body.detail.members.map((m) => m.id);
  pairs = (await admin.get(`/api/manage/teams/${teamId}/matches`)).body.map((x) => ({ santa: x.santaId, child: x.childId }));
  assert.ok(isValidDraw(left, pairs));
  // deleting a person keeps every circle whole too
  const del = await admin.del(`/api/admin/users/${ids['Buddy Elfson']}`);
  assert.equal(del.status, 200);
  const left2 = (await admin.get(`/api/manage/teams/${teamId}`)).body.members.map((m) => m.id);
  pairs = (await admin.get(`/api/manage/teams/${teamId}/matches`)).body.map((x) => ({ santa: x.santaId, child: x.childId }));
  assert.ok(isValidDraw(left2, pairs));
});

test('no demo data and no demo helpers when demo mode is off', async () => {
  const s = (await admin.get('/api/session')).body;
  assert.equal(s.demo.enabled, false);
  assert.equal((await admin.get('/api/demo/personas')).status, 404);
  const c = await env.client().init();
  const r = await c.post('/api/auth/otp/verify', { email: 'holly@example.com', code: '123456' });
  assert.equal(r.status, 401);
});

test('security headers and static files', async () => {
  const r = await fetch(`${env.base}/`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.equal((await fetch(`${env.base}/../server/app.js`)).status, 404);
  assert.equal((await fetch(`${env.base}/%2e%2e/package.json`)).status, 404);
  const h = await (await fetch(`${env.base}/healthz`)).json();
  assert.equal(h.ok, true);
});
