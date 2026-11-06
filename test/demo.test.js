'use strict';
// Demo mode uses its own database file; switching it off shows none of it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startApp } = require('./helpers');

test('demo on: made-up data, the simple code works, nothing is emailed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'santa-demo-'));
  const env = await startApp({ SANTA_DEMO_MODE: 'true', SANTA_DEMO_OTP: '424242' }, dir);
  try {
    const c = await env.client().init();
    const s = (await c.get('/api/session')).body;
    assert.deepEqual(s.demo, { enabled: true, otp: '424242' });
    const people = (await c.get('/api/demo/personas')).body;
    assert.ok(people.length > 10);
    const holly = people.find((p) => p.name === 'Holly Berry');
    await c.post('/api/auth/otp/request', { email: holly.email });
    const v = await c.post('/api/auth/otp/verify', { email: holly.email, code: '424242' });
    assert.equal(v.status, 200, v.text);
    const teams = (await c.get('/api/me/teams')).body.teams;
    assert.deepEqual(teams.map((t) => t.phase).sort(), ['ended', 'live', 'setup']);
    // demo admin is admin / admin with no forced change
    const a = await env.client().init();
    const r = await a.post('/api/auth/password', { username: 'admin', password: 'admin' });
    assert.equal(r.status, 200);
    const o = await a.get('/api/admin/outbox');
    assert.ok(o.body.rows.length > 0);
    assert.ok(o.body.rows.every((m) => m.status === 'captured'), 'demo emails are kept, never sent');
    // The two roles hold in the demo too: nobody is both, and game emails are sealed.
    assert.ok(people.filter((p) => p.role === 'admin').every((p) => !p.teams), 'no demo admin is in a game');
    const noelle = await env.client().init();
    await noelle.post('/api/auth/otp/request', { email: 'noelle.winters@example.com' });
    assert.equal((await noelle.post('/api/auth/otp/verify', { email: 'noelle.winters@example.com', code: '424242' })).status, 200);
    const game = (await noelle.get('/api/manage/teams')).body.find((t) => t.name === 'Workshop Elves');
    assert.equal((await noelle.get(`/api/manage/teams/${game.id}/matches`)).status, 200, 'the organiser sees the pairs');
    assert.equal((await noelle.post(`/api/manage/teams/${game.id}/notify`, { kind: 'matched' })).status, 200);
    assert.equal((await a.get(`/api/manage/teams/${game.id}/matches`)).status, 403, 'the admin does not');
    const after = (await a.get('/api/admin/outbox')).body.rows;
    const matched = after.filter((m) => m.kind === 'matched');
    assert.ok(matched.length > 0);
    for (const m of matched) {
      assert.deepEqual([m.to, m.toName, m.sealed], ['', '', true]);
      assert.match((await a.get(`/api/admin/outbox/${m.id}/html`)).text, /Sealed/);
    }
    assert.ok(fs.existsSync(path.join(dir, 'demo.sqlite')));
  } finally {
    await env.close();
  }

  // Same data folder, demo off: a different database with nothing from the demo.
  const real = await startApp({ SANTA_DEMO_MODE: 'false' }, dir);
  try {
    const c = await real.client().init();
    assert.equal((await c.get('/api/demo/personas')).status, 404);
    const a = await real.client().init();
    await a.post('/api/auth/password', { username: 'admin', password: 'admin' });
    await a.post('/api/auth/change-password', { current: 'admin', next: 'Real-Admin-2026' });
    const users = (await a.get('/api/admin/users')).body;
    assert.deepEqual(users.map((u) => u.username), ['admin']);
    assert.equal((await a.get('/api/admin/games')).body.length, 0);
    assert.equal((await a.get('/api/admin/locations')).body.length, 0);
    assert.ok(fs.existsSync(path.join(dir, 'santa.sqlite')));
  } finally {
    await real.close();
  }
});
