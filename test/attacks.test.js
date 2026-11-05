'use strict';
// Attack tests, with real data (demo mode off).
//
// 1. Every API route the server has - read from the router itself, so a new
//    route is swept automatically - is called by people who must get nowhere:
//    signed out, a stranger, a player of another game, a player of the same
//    game, the organiser of another game and the platform admin. Real ids are
//    filled in and the bodies carry tampered values. Nothing may succeed, and
//    the database must be byte-for-byte the same afterwards.
// 2. The secrets, field by field: a child never learns their Santa, a Santa
//    sees only their own child, a wishlist reaches only that person's Santa.
// 3. Guessing: refusals, request floods, sign-in codes and passwords are
//    stopped by the limits.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, fakeSmtp, waitFor } = require('./helpers');
const { addDays, today } = require('../server/lib/util');

let env;
let smtp;
let admin;
const P = {}; // first name -> { id, email, name, c }
const A = {}; // game A: ids of real things in it
const B = {}; // game B

const NAMES = ['Olga', 'Pete', 'Quinn', 'Rosa', 'Sam', 'Una', 'Vic', 'Wes', 'Xia', 'Zed'];

async function signIn(email) {
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

const db = () => env.app.db;
const santaOf = (teamId, childId) => db().get('SELECT santa_id FROM matches WHERE team_id = ? AND child_id = ?', teamId, childId).santa_id;
const childOf = (teamId, santaId) => db().get('SELECT child_id FROM matches WHERE team_id = ? AND santa_id = ?', teamId, santaId).child_id;
const byId = (id) => Object.values(P).find((p) => p.id === id);

function snapshot() {
  const q = (sql) => JSON.stringify(db().all(sql));
  return [
    'SELECT * FROM teams ORDER BY id',
    'SELECT * FROM team_members ORDER BY team_id, user_id',
    'SELECT * FROM matches ORDER BY team_id, santa_id',
    'SELECT * FROM gifts ORDER BY id',
    'SELECT * FROM tasks ORDER BY id',
    'SELECT * FROM task_cheers ORDER BY task_id, user_id',
    'SELECT * FROM messages ORDER BY id',
    'SELECT * FROM wishlist_items ORDER BY id',
    'SELECT * FROM exclusions ORDER BY team_id, user_a, user_b',
    'SELECT id, username, display_name, email, external_id, role, location_id, active, password_hash, hints, dnd FROM users ORDER BY id',
    'SELECT * FROM locations ORDER BY id',
    'SELECT * FROM settings ORDER BY key',
  ].map(q).join('\n');
}

// A body that would change something if the route let the caller through.
function evilBody(attacker) {
  return {
    name: 'Pwned', description: 'pwned', title: 'pwned', details: 'pwned', body: 'pwned', note: 'pwned', thanks: 'pwned',
    startDate: today(), endDate: addDays(today(), 3), matchScope: 'all',
    userId: attacker.id, userIds: [attacker.id], santaId: attacker.id, childId: attacker.id, ownerId: attacker.id,
    teamId: A.team, ownerAck: true, play: true, out: true, done: true, received: true, revealed: true,
    redraw: true, notify: false, kind: 'all', locationId: A.loc, into: A.loc, from: A.loc,
    role: 'admin', email: 'evil@evil.example', username: 'evil', displayName: 'Evil', active: false,
    csv: 'userName,ID,email\nEvil,EV1,evil@evil.example', commit: true, password: 'Evil-Password-2026', next: 'Evil-Password-2026',
    xml: '<x/>', url: 'https://evil.example/meta', enabled: true, selfSignup: true,
  };
}

// Fill a route pattern with real ids.
function fill(pattern, ids) {
  return pattern.replace(/:(\w+)/g, (_, k) => {
    if (ids[k] === undefined) throw new Error(`no value for :${k} in ${pattern}`);
    return encodeURIComponent(ids[k]);
  });
}

function routes(filter) {
  return env.app.router.routes.filter((r) => r.pattern.startsWith('/api/') && filter(r));
}

// Call every matching route as `who`; every answer must be a refusal.
async function sweep(label, who, filter, ids, { allowed = [401, 403, 404] } = {}) {
  const before = snapshot();
  const bad = [];
  for (const r of routes(filter)) {
    const url = fill(r.pattern, ids);
    const res = r.method === 'GET' ? await who.c.get(url)
      : r.method === 'DELETE' ? await who.c.del(url)
        : await who.c.req(r.method, url, evilBody(who));
    if (!allowed.includes(res.status)) bad.push(`${r.method} ${url} -> ${res.status} ${res.text.slice(0, 120)}`);
  }
  assert.deepEqual(bad, [], `${label}: these were not refused`);
  assert.equal(snapshot(), before, `${label}: the database changed`);
}

test.before(async () => {
  smtp = await fakeSmtp();
  env = await startApp({ SANTA_BASE_URL: 'https://santa.example.com' });
  // The sweeps below are refused hundreds of times on purpose; the limits get
  // their own tests at the end.
  Object.assign(env.app.limits, { perIp: 1e9, perUser: 1e9, refusals: 1e9 });

  admin = await env.client().init();
  await admin.post('/api/auth/password', { username: 'admin', password: 'admin' });
  assert.equal((await admin.post('/api/auth/change-password', { current: 'admin', next: 'Sleigh-Bells-2026' })).status, 200);
  await admin.put('/api/admin/settings/email', { host: '127.0.0.1', port: smtp.port, security: 'none', fromName: 'Santa', fromEmail: 'santa@example.com' });
  A.loc = (await admin.post('/api/admin/locations', { name: 'North Pole' })).body.id
    || (await admin.get('/api/locations')).body.find((l) => l.name === 'North Pole').id;
  for (const n of NAMES) {
    const email = `${n.toLowerCase()}@attack.example`;
    const r = await admin.post('/api/admin/users', { username: `${n} Test`, externalId: `AT-${n}`, email, locationId: A.loc });
    assert.equal(r.status, 200, r.text);
    P[n] = { id: r.body.id, email, name: `${n} Test` };
  }
  for (const n of NAMES) P[n].c = await signIn(P[n].email);

  // Game A: organised by Olga (not playing), played by Pete, Quinn, Rosa, Sam.
  let r = await P.Olga.c.post('/api/manage/teams', { name: 'Game A', startDate: today(), endDate: addDays(today(), 10), matchScope: 'all' });
  assert.equal(r.status, 200, r.text);
  A.team = r.body.id;
  r = await P.Olga.c.post(`/api/manage/teams/${A.team}/members`, { userIds: ['Pete', 'Quinn', 'Rosa', 'Sam'].map((n) => P[n].id) });
  assert.equal(r.status, 200, r.text);
  assert.equal((await P.Olga.c.post(`/api/manage/teams/${A.team}/draw`, { notify: false })).status, 200);
  A.code = db().get('SELECT invite_code FROM teams WHERE id = ?', A.team).invite_code;

  // Game B: organised by Una (not playing), played by Vic, Wes, Xia, Zed.
  r = await P.Una.c.post('/api/manage/teams', { name: 'Game B', startDate: today(), endDate: addDays(today(), 10), matchScope: 'all' });
  B.team = r.body.id;
  await P.Una.c.post(`/api/manage/teams/${B.team}/members`, { userIds: ['Vic', 'Wes', 'Xia', 'Zed'].map((n) => P[n].id) });
  assert.equal((await P.Una.c.post(`/api/manage/teams/${B.team}/draw`, { notify: false })).status, 200);

  // Real things in game A: each Santa logs a gift, sets a task and writes a note;
  // each child replies. Rosa has a wishlist item with a unique marker.
  for (const n of ['Pete', 'Quinn', 'Rosa', 'Sam']) {
    const c = P[n].c;
    assert.equal((await c.post(`/api/teams/${A.team}/gifts`, { description: `gift-from-${n}` })).status, 200);
    assert.equal((await c.post(`/api/teams/${A.team}/tasks`, { title: `task-from-${n}` })).status, 200);
    assert.equal((await c.post(`/api/teams/${A.team}/messages/child`, { body: `note-from-santa-${n}` })).status, 200);
    assert.equal((await c.post(`/api/teams/${A.team}/messages/santa`, { body: `note-from-child-${n}` })).status, 200);
  }
  await P.Rosa.c.post('/api/me/wishlist', { title: 'ROSA-SECRET-WISH', notes: 'ROSA-SECRET-NOTE' });
  await P.Rosa.c.put('/api/me', { hints: { likes: 'ROSA-SECRET-HINT' } });
  assert.equal((await P.Rosa.c.post(`/api/teams/${A.team}/accept`)).status, 200, 'Rosa says yes to game A');
  // Sam was added by the organiser and has NOT said yes.
  await P.Sam.c.post('/api/me/wishlist', { title: 'SAM-SECRET-WISH' });
  await P.Sam.c.put('/api/me', { hints: { likes: 'SAM-SECRET-HINT' } });
  A.item = db().get('SELECT id FROM wishlist_items WHERE title = ?', 'ROSA-SECRET-WISH').id;
  // Ids for the sweeps: a gift and a task in A that do NOT involve Quinn.
  const notQuinn = db().get('SELECT santa_id FROM matches WHERE team_id = ? AND santa_id <> ? AND child_id <> ?', A.team, P.Quinn.id, P.Quinn.id).santa_id;
  A.gift = db().get('SELECT id FROM gifts WHERE team_id = ? AND santa_id = ?', A.team, notQuinn).id;
  A.task = db().get('SELECT id FROM tasks WHERE team_id = ? AND santa_id = ?', A.team, notQuinn).id;
  A.other = db().get('SELECT child_id FROM matches WHERE team_id = ? AND santa_id = ?', A.team, notQuinn).child_id;
  A.mail = db().get('SELECT id FROM outbox ORDER BY id DESC LIMIT 1').id;
});
test.after(async () => {
  await env.close();
  await smtp.close();
});

const idsFor = (game) => ({
  teamId: game.team, giftId: A.gift, taskId: A.task, userId: A.other, itemId: A.item, side: 'santa',
  code: 'zzzzzzzzzz', a: P.Pete.id, b: P.Quinn.id, locId: A.loc, mailId: A.mail, kind: 'matched',
});

// ---- 1. every route, the wrong people ----------------------------------------------

test('signed out: every route that needs a sign-in answers 401 and changes nothing', async () => {
  const anon = { c: await env.client().init(), id: 0 };
  await sweep('signed out', anon, (r) => (r.opts.auth || 'user') !== 'none', idsFor(A), { allowed: [401] });
});

test('the sign-in-free routes give a stranger nothing', async () => {
  const anon = await env.client().init();
  const open = routes((r) => r.opts.auth === 'none').map((r) => `${r.method} ${r.pattern}`).sort();
  assert.deepEqual(open, [
    'GET /api/demo/personas', 'GET /api/session', 'POST /api/auth/logout',
    'POST /api/auth/otp/request', 'POST /api/auth/otp/verify', 'POST /api/auth/password',
  ].sort(), 'a new route reachable without signing in - review it, then add it here');
  assert.equal((await anon.get('/api/demo/personas')).status, 404, 'no persona list with demo mode off');
  const s = (await anon.get('/api/session')).body;
  assert.equal(s.user, null);
  assert.equal(JSON.stringify(s).includes('@attack.example'), false, 'the session endpoint names nobody');
  // Unknown and known addresses get the same answer (a known one nobody asked a code for moments ago).
  assert.equal((await admin.post('/api/admin/users', { username: 'Kim Test', externalId: 'AT-Kim', email: 'kim@attack.example', locationId: A.loc })).status, 200);
  const known = await anon.post('/api/auth/otp/request', { email: 'kim@attack.example' });
  const unknown = await anon.post('/api/auth/otp/request', { email: 'nobody@attack.example' });
  assert.equal(known.status, unknown.status);
  assert.deepEqual(Object.keys(known.body).sort(), Object.keys(unknown.body).sort());
});

test('players and organisers are refused every admin route', async () => {
  await sweep('player', P.Quinn, (r) => r.pattern.startsWith('/api/admin/'), idsFor(A), { allowed: [403] });
  await sweep('organiser', P.Olga, (r) => r.pattern.startsWith('/api/admin/'), idsFor(A), { allowed: [403] });
});

test('nobody but the organiser reaches any management route of a game', async () => {
  const manage = (r) => r.pattern.startsWith('/api/manage/teams/:teamId');
  await sweep('a player of the game', P.Quinn, manage, idsFor(A));
  await sweep('a stranger', P.Zed, manage, idsFor(A));
  await sweep('the organiser of another game', P.Una, manage, idsFor(A));
  await sweep('the platform admin', { c: admin, id: 1 }, manage, idsFor(A));
});

test('nobody outside a game reaches any of its player routes', async () => {
  const play = (r) => r.pattern.startsWith('/api/teams/:teamId');
  await sweep('a player of another game', P.Zed, play, idsFor(A), { allowed: [400, 403, 404, 409] });
  await sweep('the organiser of another game', P.Una, play, idsFor(A), { allowed: [400, 403, 404, 409] });
  await sweep('the platform admin', { c: admin, id: 1 }, play, idsFor(A), { allowed: [400, 403, 404, 409] });
});

test('ids from another game are refused, even through a game you are in', async () => {
  const objects = (r) => /\/api\/teams\/:teamId\/(gifts|tasks)\/:/.test(r.pattern);
  await sweep('game B player with game A ids', P.Zed, objects, idsFor(B));
});

test('inside a game: another pair\'s gifts and tasks cannot be touched', async () => {
  const objects = (r) => /\/api\/teams\/:teamId\/(gifts|tasks)\/:/.test(r.pattern) && !r.pattern.endsWith('/cheer');
  await sweep('a player of the same game', P.Quinn, objects, idsFor(A));
});

test('nobody edits, deletes or reads another person\'s wishlist', async () => {
  await sweep('another player', P.Quinn, (r) => r.pattern.startsWith('/api/me/wishlist/'), idsFor(A));
  const mine = (await P.Quinn.c.get('/api/me/wishlist')).body;
  assert.equal(JSON.stringify(mine).includes('ROSA-SECRET'), false);
});

test('the profile cannot be used to become admin or someone else', async () => {
  const before = db().get('SELECT role, email, username, external_id, active FROM users WHERE id = ?', P.Quinn.id);
  const r = await P.Quinn.c.put('/api/me', { role: 'admin', email: P.Rosa.email, username: 'admin', externalId: 'X', active: 0, id: P.Rosa.id, mustChangePassword: false });
  assert.ok(r.status < 500, r.text);
  assert.deepEqual(db().get('SELECT role, email, username, external_id, active FROM users WHERE id = ?', P.Quinn.id), before);
  assert.equal((await P.Quinn.c.get('/api/admin/overview')).status, 403);
});

test('a value smuggled into a gift, task or note goes to your own child only', async () => {
  const c = P.Quinn.c;
  const child = childOf(A.team, P.Quinn.id);
  const evil = { santaId: P.Pete.id, childId: P.Sam.id, teamId: B.team, team_id: B.team, santa_id: P.Pete.id, child_id: P.Sam.id };
  assert.equal((await c.post(`/api/teams/${A.team}/gifts`, { description: 'smuggled-gift', ...evil })).status, 200);
  assert.equal((await c.post(`/api/teams/${A.team}/tasks`, { title: 'smuggled-task', ...evil })).status, 200);
  assert.equal((await c.post(`/api/teams/${A.team}/messages/child`, { body: 'smuggled-note', ...evil })).status, 200);
  for (const [table, col, value] of [['gifts', 'description', 'smuggled-gift'], ['tasks', 'title', 'smuggled-task'], ['messages', 'body', 'smuggled-note']]) {
    const row = db().get(`SELECT team_id, santa_id, child_id FROM ${table} WHERE ${col} = ?`, value);
    assert.deepEqual({ ...row }, { team_id: A.team, santa_id: P.Quinn.id, child_id: child }, table);
  }
});

// ---- 2. the secrets -----------------------------------------------------------------

const SANTA_KEY = /santa(?!Name$)|setter|giver|author|from(?!Santa$)|createdBy|^by(?!Me$)/i;
const SAFE_KEYS = new Set(['hasSanta', 'fromSanta']); // booleans / the section's own name
const santaKeys = (v) => keysIn(v).filter((k) => SANTA_KEY.test(k) && !SAFE_KEYS.has(k));

function keysIn(value, out = []) {
  if (Array.isArray(value)) value.forEach((v) => keysIn(v, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) { out.push(k); keysIn(v, out); }
  }
  return out;
}

test('a child learns nothing about their Santa - not from any field, gift, task, note or the board', async () => {
  for (const n of ['Pete', 'Quinn', 'Rosa', 'Sam']) {
    const me = P[n];
    const santa = byId(santaOf(A.team, me.id));
    const views = {
      team: (await me.c.get(`/api/teams/${A.team}`)).body,
      board: (await me.c.get(`/api/teams/${A.team}/board`)).body,
      notes: (await me.c.get(`/api/teams/${A.team}/messages/santa`)).body,
      home: (await me.c.get('/api/me/teams')).body,
      me: (await me.c.get('/api/me')).body,
    };
    assert.ok(views.team && views.board && views.notes && views.home, `${n}: views load`);
    // What came from my Santa carries no trace of who that is.
    const fromSanta = JSON.stringify([views.team.fromSanta, views.notes]);
    assert.equal(fromSanta.includes(santa.name), false, `${n}: Santa's name in what Santa sent`);
    assert.equal(fromSanta.includes(santa.email), false, `${n}: Santa's email in what Santa sent`);
    assert.deepEqual(santaKeys([views.team.fromSanta, views.notes]), [], `${n}: a Santa-shaped key`);
    // The board says who a task is for, never who set it; "byMe" only on my own.
    for (const t of views.board) {
      const row = db().get('SELECT santa_id FROM tasks WHERE id = ?', t.id);
      assert.deepEqual(santaKeys(t), [], `${n}: board key`);
      assert.equal(Boolean(t.byMe), row.santa_id === me.id, `${n}: byMe`);
      if (row.santa_id !== me.id) assert.equal(JSON.stringify(t).includes(byId(row.santa_id).name), false, `${n}: setter named on the board`);
    }
    // Nowhere before the reveal.
    const game = views.home.teams.find((t) => t.id === A.team);
    assert.equal(game.santaName, null, `${n}: santaName before the reveal`);
    assert.equal(JSON.stringify(views.team).includes(`"santaId"`), false);
    assert.equal(JSON.stringify(views).includes(santa.email), false, `${n}: Santa's email anywhere`);
  }
});

test('a Santa sees only their own child; other people\'s wishlists and hints reach nobody else', async () => {
  const rosasSanta = byId(santaOf(A.team, P.Rosa.id));
  for (const n of NAMES) {
    const me = P[n];
    const seen = [];
    for (const url of ['/api/me/teams', '/api/me', '/api/me/wishlist', `/api/teams/${A.team}`, `/api/teams/${A.team}/board`,
      `/api/teams/${A.team}/messages/child`, `/api/teams/${B.team}`, '/api/directory?q=Test']) {
      const r = await me.c.get(url);
      if (r.status === 200) seen.push(r.text);
    }
    const all = seen.join('\n');
    const allowed = me.id === rosasSanta.id || me.id === P.Rosa.id;
    assert.equal(all.includes('ROSA-SECRET-WISH'), allowed, `${n}: Rosa's wishlist`);
    assert.equal(all.includes('ROSA-SECRET-HINT'), allowed, `${n}: Rosa's hints`);
    if (me.id !== P.Rosa.id && me.id !== rosasSanta.id) {
      const team = JSON.parse(seen[3] || '{}');
      if (team.child) assert.notEqual(team.child.name, P.Rosa.name, `${n} was shown Rosa as their child`);
    }
  }
});

test('a player never sees other people\'s email addresses', async () => {
  const others = NAMES.filter((n) => n !== 'Quinn').map((n) => P[n].email);
  for (const url of ['/api/me/teams', `/api/teams/${A.team}`, `/api/teams/${A.team}/board`, '/api/directory?q=Test', '/api/directory?q=attack.example']) {
    const r = await P.Quinn.c.get(url);
    for (const e of others) assert.equal(r.text.includes(e), false, `${url} shows ${e}`);
  }
});

test('the platform admin cannot learn who is whose Santa - not from the outbox, audit log or game list', async () => {
  // The match emails go out; the admin's outbox keeps them.
  assert.equal((await P.Olga.c.post(`/api/manage/teams/${A.team}/draw`, { redraw: true, notify: true })).status, 200);
  await waitFor(() => db().get("SELECT COUNT(*) AS n FROM outbox WHERE kind = 'matched' AND status = 'sent'").n >= 4);
  const texts = [];
  const list = await admin.get('/api/admin/outbox');
  assert.equal(list.status, 200);
  texts.push(list.text);
  for (const m of db().all('SELECT id FROM outbox ORDER BY id')) texts.push((await admin.get(`/api/admin/outbox/${m.id}/html`)).text);
  texts.push((await admin.get('/api/admin/audit')).text, (await admin.get('/api/admin/games')).text, (await admin.get('/api/admin/overview')).text);
  // Every email addressed to a Santa, as the admin sees it, must not name that
  // Santa's child - in the list or in the email itself.
  const leaks = [];
  for (const row of db().all('SELECT santa_id, child_id FROM matches WHERE team_id = ?', A.team)) {
    const santa = byId(row.santa_id);
    const child = byId(row.child_id);
    for (const m of db().all('SELECT id FROM outbox WHERE to_email = ?', santa.email)) {
      const one = (await admin.get(`/api/admin/outbox/${m.id}/html`)).text;
      if (one.includes(child.name)) leaks.push(`mail ${m.id} to ${santa.name} names ${child.name}`);
    }
    // The list shows each email's recipient, kind and subject; none addressed
    // to this Santa may carry the child's name.
    for (const r of list.body.rows.filter((x) => x.to === santa.email)) {
      if (JSON.stringify(r).includes(child.name)) leaks.push(`outbox row ${r.id} to ${santa.name} names ${child.name}`);
    }
  }
  assert.deepEqual(leaks, [], 'the admin can read a pairing from the outbox');
  for (const t of texts.slice(-3)) {
    for (const row of db().all('SELECT santa_id, child_id FROM matches WHERE team_id = ?', A.team)) {
      assert.equal(t.includes(byId(row.santa_id).name) && t.includes(byId(row.child_id).name) && /->|→/.test(t), false, 'a pairing in the audit log, games or overview');
    }
  }
});

test('being added to a game is not saying yes: the wishlist and hints wait for the child', async () => {
  // Anyone can make a game and add anyone. Sam was added by the organiser and never said yes.
  const santa = byId(santaOf(A.team, P.Sam.id));
  let v = (await santa.c.get(`/api/teams/${A.team}`)).body;
  assert.equal(v.child.saidYes, false);
  assert.deepEqual(v.child.wishlist, []);
  assert.equal(JSON.stringify(v).includes('SAM-SECRET'), false, 'nothing of Sam\'s reaches their Santa');
  // ...nor the match email, nor the organiser.
  assert.equal((await P.Olga.c.post(`/api/manage/teams/${A.team}/notify`, { kind: 'matched' })).status, 200);
  await waitFor(() => !db().get("SELECT 1 FROM outbox WHERE status = 'queued' LIMIT 1"));
  assert.equal(smtp.messages.some((m) => m.data.includes('SAM-SECRET')), false, 'the match email has no peek before a yes');
  assert.equal(JSON.stringify((await P.Olga.c.get(`/api/manage/teams/${A.team}`)).body).includes('SAM-SECRET'), false);
  // Sam says yes: now their Santa sees it.
  assert.equal((await P.Sam.c.post(`/api/teams/${A.team}/accept`)).status, 200);
  v = (await santa.c.get(`/api/teams/${A.team}`)).body;
  assert.equal(v.child.saidYes, true);
  assert.ok(JSON.stringify(v).includes('SAM-SECRET-WISH') && JSON.stringify(v).includes('SAM-SECRET-HINT'));
  // A stranger cannot say yes on Sam's behalf - or for a game they are not in.
  assert.equal((await P.Zed.c.post(`/api/teams/${A.team}/accept`, { userId: P.Sam.id })).status, 403);
});

test('the admin cannot take a game over, or borrow someone\'s sign-in, to read the Santa list', async () => {
  const adminId = db().get("SELECT id FROM users WHERE username = 'admin'").id;
  const owner = () => db().get('SELECT owner_id FROM teams WHERE id = ?', A.team).owner_id;
  assert.equal((await admin.put(`/api/admin/games/${A.team}/owner`, { userId: adminId })).status, 400, 'not to an admin');
  const puppet = await admin.post('/api/admin/users', { username: 'Sock Puppet', externalId: 'AT-SP', email: 'puppet@attack.example', locationId: A.loc });
  assert.equal((await admin.put(`/api/admin/games/${A.team}/owner`, { userId: puppet.body.id })).status, 400, 'not to a made-up account');
  assert.equal(owner(), P.Olga.id);
  // A player's sign-in cannot be changed while their Santa is secret.
  const pete = db().get('SELECT * FROM users WHERE id = ?', P.Pete.id);
  assert.equal((await admin.post(`/api/admin/users/${P.Pete.id}/password`, { password: 'Admin-Knows-2026' })).status, 409);
  assert.equal((await admin.put(`/api/admin/users/${P.Pete.id}`, { username: pete.username, email: 'admin-inbox@attack.example', externalId: pete.external_id, locationId: A.loc })).status, 409);
  const csv = `userName,ID,email\n${pete.username},${pete.external_id},admin-inbox@attack.example`;
  await admin.post('/api/admin/users/import', { csv, commit: true });
  assert.equal(db().get('SELECT email, password_hash FROM users WHERE id = ?', P.Pete.id).email, P.Pete.email, 'not by CSV either');
  assert.equal(db().get('SELECT password_hash FROM users WHERE id = ?', P.Pete.id).password_hash, null);
  // Someone in no secret game is the admin's to manage as usual.
  assert.equal((await admin.post(`/api/admin/users/${puppet.body.id}/password`, { password: 'Fine-Now-2026x' })).status, 200);
});

test('an organiser who plays opens the Santa list only after accepting the spoiler', async () => {
  // Una organises game B; she joins as a player, then the game "changes hands" back to her.
  assert.equal((await P.Una.c.post(`/api/manage/teams/${B.team}/play`, { play: true, ownerAck: true })).status, 200);
  db().run('UPDATE teams SET owner_ack_at = NULL WHERE id = ?', B.team); // what a hand-over does
  const r = await P.Una.c.get(`/api/manage/teams/${B.team}/matches`);
  assert.equal(r.status, 409);
  assert.equal(r.body.details.code, 'owner_ack');
  assert.equal((await P.Una.c.post(`/api/manage/teams/${B.team}/play`, { play: true, ownerAck: true })).status, 200);
  assert.equal((await P.Una.c.get(`/api/manage/teams/${B.team}/matches`)).status, 200);
});

test('the people search is a search: no list, no addresses, no peeking into other games', async () => {
  assert.deepEqual((await P.Zed.c.get('/api/directory')).body, [], 'no query, no list');
  assert.deepEqual((await P.Zed.c.get('/api/directory?q=a')).body, [], 'one letter is not enough');
  const found = (await P.Zed.c.get('/api/directory?q=Test')).body;
  assert.ok(found.length > 0 && found.length <= 25);
  for (const u of found) assert.deepEqual(Object.keys(u).sort(), ['emailHint', 'id', 'location', 'me', 'name']);
  assert.equal((await P.Zed.c.get('/api/directory?q=attack.example')).body.length, 0, 'part of an address finds nobody');
  assert.equal((await P.Zed.c.get(`/api/directory?q=${encodeURIComponent(P.Rosa.email)}`)).body.length, 1, 'a full address does');
  assert.equal((await P.Zed.c.get(`/api/directory?q=Test&notInTeam=${A.team}`)).status, 403, 'not someone else\'s game');
  const detail = JSON.stringify((await P.Olga.c.get(`/api/manage/teams/${A.team}`)).body);
  for (const n of NAMES) assert.equal(detail.includes(P[n].email), false, `the organiser sees ${n}'s full address`);
  assert.equal(detail.includes('AT-'), false, 'the organiser sees employee ids');
  // Searching fast is stopped.
  env.app.auth.limiter.clear(`directory:${P.Wes.id}`);
  let limited = 0;
  for (let i = 0; i < 65; i += 1) if ((await P.Wes.c.get(`/api/directory?q=T${'abcdefghij'[i % 10]}`)).status === 429) limited += 1;
  assert.ok(limited >= 5, `only ${limited} searches refused`);
});

test('a change of Santa leaves no trace on the child\'s side of the notes', async () => {
  const email = 'nia@attack.example';
  const nia = await admin.post('/api/admin/users', { username: 'Nia Test', externalId: 'AT-Nia', email, locationId: A.loc });
  P.Nia = { id: nia.body.id, email, name: 'Nia Test', c: await signIn(email) };
  const players = ['Pete', 'Quinn', 'Rosa', 'Sam'];
  const threads = async () => Object.fromEntries(await Promise.all(players.map(async (n) => [n, (await P[n].c.get(`/api/teams/${A.team}/messages/santa`)).body.map((m) => m.id)])));
  const before = await threads();
  const santasBefore = players.map((n) => santaOf(A.team, P[n].id));
  assert.equal((await P.Olga.c.post(`/api/manage/teams/${A.team}/members`, { userIds: [P.Nia.id] })).status, 200);
  assert.equal((await P.Olga.c.post(`/api/manage/teams/${A.team}/members/${P.Nia.id}/insert`, {})).status, 200);
  assert.notDeepEqual(players.map((n) => santaOf(A.team, P[n].id)), santasBefore, 'someone got a new Santa');
  assert.deepEqual(await threads(), before, 'every child\'s notes look exactly as before');
});

test('team emails sent by hand are capped, so a game cannot be used to spam people', async () => {
  env.app.auth.limiter.clear(`team-mail:${B.team}`);
  let refused = 0;
  for (let i = 0; i < 8; i += 1) if ((await P.Una.c.post(`/api/manage/teams/${B.team}/notify`, { kind: 'reminder' })).status === 429) refused += 1;
  assert.equal(refused, 2, 'six a day per game');
});

test('the sign-in page shows no text a stranger put in a link', async () => {
  const anon = await env.client().init();
  const r = await anon.get('/auth/azure/callback?error=access_denied&error_description=Call%20+1-555-SCAM%20now');
  const where = r.headers.get('location') || '';
  assert.equal(where.includes('SCAM'), false, where);
});

test('Microsoft sign-in refuses a multi-tenant authority', async () => {
  const { loadConfig } = require('../server/config');
  const { createApp } = require('../server/app');
  for (const tenant of ['common', 'organizations', 'consumers']) {
    const app = createApp(loadConfig({ SANTA_DATA_DIR: env.dir, SANTA_AZURE_TENANT_ID: tenant, SANTA_AZURE_CLIENT_ID: 'x' }, []));
    try {
      assert.equal(app.azure.status().configured, false, tenant);
    } finally { app.stop(); }
  }
});

// ---- 3. guessing --------------------------------------------------------------------

test('guessing invite codes, ids or games is stopped by the refusal limit', async () => {
  // The sweeps above were refused hundreds of times from this same address.
  const clear = () => ['refused:u' + P.Xia.id, 'refused-ip:127.0.0.1'].forEach((k) => env.app.auth.limiter.clear(k));
  clear();
  Object.assign(env.app.limits, { refusals: 5 });
  try {
    const c = P.Xia.c;
    for (let i = 0; i < 5; i += 1) assert.equal((await c.get(`/api/join/zzzzzzzzz${'23456'[i]}`)).status, 404);
    const r = await c.get('/api/join/zzzzzzzzz9');
    assert.equal(r.status, 429, 'the sixth wrong guess is refused');
    assert.ok(Number(r.headers.get('retry-after')) > 0);
    assert.equal((await c.get(`/api/join/${A.code}`)).status, 429, 'even a right code waits now');
    assert.equal((await c.get(`/api/teams/${A.team}`)).status, 429, 'and so does everything else');
    assert.equal((await P.Wes.c.get('/api/me')).status, 200, 'other people are not affected');
  } finally {
    Object.assign(env.app.limits, { refusals: 1e9 });
    clear();
  }
});

test('a flood of requests from one person is slowed down', async () => {
  Object.assign(env.app.limits, { perUser: 20 });
  try {
    let limited = 0;
    for (let i = 0; i < 25; i += 1) if ((await P.Wes.c.get('/api/me')).status === 429) limited += 1;
    assert.ok(limited >= 4, `only ${limited} refused`);
  } finally {
    Object.assign(env.app.limits, { perUser: 1e9 });
    env.app.auth.limiter.clear(`api-user:${P.Wes.id}`);
  }
});

test('sign-in codes cannot be guessed: a code dies after 5 wrong tries', async () => {
  const email = 'yan@attack.example'; // a fresh address: nobody asked for a code moments ago
  assert.equal((await admin.post('/api/admin/users', { username: 'Yan Test', externalId: 'AT-Yan', email, locationId: A.loc })).status, 200);
  const c = await env.client().init();
  const before = smtp.messages.length;
  assert.equal((await c.post('/api/auth/otp/request', { email })).status, 200);
  const msg = await waitFor(() => smtp.messages.slice(before).find((m) => m.rcpt.join().includes(email) && /\d{6} is your/.test(m.data)));
  const code = /(\d{6}) is your/.exec(msg.data)[1];
  const wrong = code === '000000' ? '111111' : '000000';
  for (let i = 0; i < 5; i += 1) assert.notEqual((await c.post('/api/auth/otp/verify', { email, code: wrong })).status, 200);
  const late = await c.post('/api/auth/otp/verify', { email, code });
  assert.notEqual(late.status, 200, 'the right code no longer works after 5 wrong ones');
});

test('sign-in codes cannot be guessed slowly either: 15 wrong codes a day closes the address for the day', async () => {
  const email = 'yan@attack.example';
  for (let i = 0; i < 15; i += 1) env.app.auth.limiter.take(`otp-bad-day:${email}`, Infinity, 86400e3);
  env.app.auth.limiter.clear(`otp-verify:${email}`);
  const r = await (await env.client().init()).post('/api/auth/otp/verify', { email, code: '123456' });
  assert.equal(r.status, 429);
  assert.match(r.body.error, /today/);
  env.app.auth.limiter.clear(`otp-bad-day:${email}`);
});

test('passwords cannot be guessed: an account locks after 8 wrong tries', async () => {
  const c = await env.client().init();
  for (let i = 0; i < 8; i += 1) assert.equal((await c.post('/api/auth/password', { username: 'admin', password: `wrong-${i}` })).status, 401);
  const r = await c.post('/api/auth/password', { username: 'admin', password: 'Sleigh-Bells-2026' });
  assert.equal(r.status, 429, 'even the right password waits');
  env.app.auth.limiter.clear('pw:admin:127.0.0.1');
  env.app.auth.limiter.clear('pw:admin');
});
