'use strict';
// Anyone can create a game and owns it; the platform admin does not run games.
// An organiser plays in their own game only after accepting the spoiler.
// Players join by invite code or open sign-up; new people can sign up by code.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers');
const { addDays, today } = require('../server/lib/util');

let env;
let admin;
const ids = {};

async function signIn(email) {
  const c = await env.client().init();
  await c.post('/api/auth/otp/request', { email });
  const r = await c.post('/api/auth/otp/verify', { email, code: '123456' });
  assert.equal(r.status, 200, r.text);
  return c;
}

test.before(async () => {
  env = await startApp({ SANTA_DEMO_MODE: 'true', SANTA_BASE_URL: 'https://santa.example.com' });
  admin = await env.client().init();
  await admin.post('/api/auth/password', { username: 'admin', password: 'admin' });
  const loc = (await admin.get('/api/locations')).body[0].id;
  for (const n of ['Olga', 'Pete', 'Quinn', 'Rosa']) {
    const r = await admin.post('/api/admin/users', { username: `${n} Owner`, externalId: `O-${n}`, email: `${n.toLowerCase()}@own.example`, locationId: loc });
    ids[n] = r.body.id;
  }
});
test.after(() => env.close());

let gameId;
let olga;

test('any player can create a game and owns it', async () => {
  olga = await signIn('olga@own.example');
  const r = await olga.post('/api/manage/teams', { name: 'Olga Party', startDate: addDays(today(), 2), endDate: addDays(today(), 12), matchScope: 'all' });
  assert.equal(r.status, 200, r.text);
  gameId = r.body.id;
  const mine = (await olga.get('/api/manage/teams')).body;
  assert.deepEqual(mine.map((t) => t.id), [gameId]);
  const home = (await olga.get('/api/me/teams')).body;
  assert.equal(home.organising.length, 1);
  assert.equal(home.organising[0].owner.name, 'Olga Owner');
});

test('nobody else runs it - not another player, not the platform admin', async () => {
  const pete = await signIn('pete@own.example');
  assert.equal((await pete.get(`/api/manage/teams/${gameId}`)).status, 403);
  assert.equal((await pete.post(`/api/manage/teams/${gameId}/draw`, {})).status, 403);
  assert.equal((await admin.get(`/api/manage/teams/${gameId}`)).status, 403);
  assert.equal((await admin.get(`/api/manage/teams/${gameId}/matches`)).status, 403, 'the admin never sees a Santa list');
  const games = (await admin.get('/api/admin/games')).body;
  const g = games.find((x) => x.id === gameId);
  assert.equal(g.owner.name, 'Olga Owner');
  assert.equal('inviteCode' in g, false);
});

test('the organiser plays only after accepting they can see their own Santa', async () => {
  const no = await olga.post(`/api/manage/teams/${gameId}/members`, { userIds: [ids.Olga, ids.Pete] });
  assert.equal(no.status, 409);
  assert.equal(no.body.details.code, 'owner_ack');
  const yes = await olga.post(`/api/manage/teams/${gameId}/members`, { userIds: [ids.Olga, ids.Pete], ownerAck: true });
  assert.equal(yes.status, 200, yes.text);
  assert.equal(yes.body.detail.team.ownerPlays, true);
  assert.equal(yes.body.detail.team.ownerAccepted, true);
});

test('players join with the invite code; the code can be replaced', async () => {
  const d = (await olga.get(`/api/manage/teams/${gameId}`)).body;
  const code = d.team.inviteCode;
  assert.match(code, /^[a-z2-9]{10}$/);
  const quinn = await signIn('quinn@own.example');
  const preview = (await quinn.get(`/api/join/${code}`)).body;
  assert.equal(preview.team.name, 'Olga Party');
  assert.equal(preview.team.organiser, 'Olga Owner');
  assert.equal(preview.canJoin, true);
  // a pasted link works as well as the bare code
  const j = await quinn.post(`/api/join/${encodeURIComponent(`https://santa.example.com/#/join/${code}`)}`, {});
  assert.equal(j.status, 200, j.text);
  assert.equal((await quinn.get(`/api/join/${code}`)).body.alreadyIn, true);
  const reset = (await olga.post(`/api/manage/teams/${gameId}/invite/reset`)).body;
  assert.notEqual(reset.team.inviteCode, code);
  const rosa = await signIn('rosa@own.example');
  assert.equal((await rosa.get(`/api/join/${code}`)).status, 404, 'the old code no longer works');
  assert.equal((await rosa.post(`/api/join/${reset.team.inviteCode}`, {})).status, 200);
});

test('after the draw the organiser sees the list (own Santa included); late joins are refused', async () => {
  const dr = await olga.post(`/api/manage/teams/${gameId}/draw`, {});
  assert.equal(dr.status, 200, dr.text);
  const list = (await olga.get(`/api/manage/teams/${gameId}/matches`)).body;
  assert.equal(list.length, 4);
  assert.ok(list.some((m) => m.childId === ids.Olga), 'the organiser can see who their own Santa is - as accepted');
  const code = (await olga.get(`/api/manage/teams/${gameId}`)).body.team.inviteCode;
  const late = await signIn('pete@own.example');
  const r = await late.get(`/api/join/${code}`);
  assert.equal(r.body.alreadyIn, true);
  const other = await env.client().init();
  await other.post('/api/auth/otp/request', { email: 'holly.berry@example.com' });
  await other.post('/api/auth/otp/verify', { email: 'holly.berry@example.com', code: '123456' });
  const refused = await other.post(`/api/join/${code}`, {});
  assert.equal(refused.status, 409);
});

test('the admin can hand a game to a new owner, who must accept again to play', async () => {
  const r = await admin.put(`/api/admin/games/${gameId}/owner`, { userId: ids.Pete });
  assert.equal(r.status, 200, r.text);
  assert.equal((await olga.get(`/api/manage/teams/${gameId}`)).status, 403);
  const pete = await signIn('pete@own.example');
  const d = (await pete.get(`/api/manage/teams/${gameId}`)).body;
  assert.equal(d.team.ownerAccepted, false);
  assert.equal(d.team.ownerPlays, true);
});

test('the directory lists people an organiser can add', async () => {
  const pete = await signIn('pete@own.example');
  const all = (await pete.get('/api/directory?q=Owner')).body;
  assert.deepEqual(all.map((u) => u.name).sort(), ['Olga Owner', 'Pete Owner', 'Quinn Owner', 'Rosa Owner']);
  const notIn = (await pete.get(`/api/directory?q=Owner&notInTeam=${gameId}`)).body;
  assert.equal(notIn.length, 0);
});

test('open sign-up with an email code, limited to the allowed domains', async () => {
  const stranger = await env.client().init();
  await stranger.post('/api/auth/otp/request', { email: 'newbie@fresh.example' });
  let v = await stranger.post('/api/auth/otp/verify', { email: 'newbie@fresh.example', code: '123456' });
  assert.equal(v.status, 401, 'sign-up is off by default');
  const s = await admin.put('/api/admin/settings/auth', { otpEnabled: true, azureEnabled: true, selfSignup: true, signupDomains: 'fresh.example' });
  assert.equal(s.status, 200, s.text);
  const session = (await stranger.get('/api/session')).body;
  assert.equal(session.signIn.selfSignup, true);
  v = await stranger.post('/api/auth/otp/verify', { email: 'newbie@fresh.example', code: '123456' });
  assert.equal(v.status, 200, v.text);
  assert.equal(v.body.user.name, 'Newbie');
  const other = await env.client().init();
  const w = await other.post('/api/auth/otp/verify', { email: 'someone@elsewhere.example', code: '123456' });
  assert.equal(w.status, 401, 'other domains cannot sign up');
  // and the newcomer can create a game straight away
  const g = await stranger.post('/api/manage/teams', { name: 'Newbie Night', startDate: today(), endDate: addDays(today(), 3) });
  assert.equal(g.status, 200, g.text);
});
