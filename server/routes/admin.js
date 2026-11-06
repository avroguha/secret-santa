'use strict';
// The platform: people, locations, sign-in, email, guidelines, the outbox and
// the audit log. Games belong to their owners (routes/manage.js); an admin can
// only see the list of games, hand one to a new owner, or delete it.
const { fail, text, id, optionalId, int, bool, date, oneOf, nowIso, today, isEmail, normEmail, hashPassword, displayName } = require('../lib/util');
const { toCsv } = require('../lib/csv');
const { sendText } = require('../lib/http');
const T = require('../services/teams');
const U = require('../services/users');
const emails = require('../services/emails');
const { isSealed } = require('../services/mailer');

const A = { auth: 'admin' };

module.exports = function adminRoutes(router, app) {
  const { db, config } = app;

  // All a platform admin ever sees of a game.
  const gameFacts = (s) => ({
    id: s.id, name: s.name, owner: s.owner, phase: s.phase, startDate: s.startDate, endDate: s.endDate,
    memberCount: s.memberCount, joinOpen: s.joinOpen, createdAt: s.createdAt,
  });

  // ---- overview -------------------------------------------------------------------
  router.get('/api/admin/overview', () => {
    const day = today();
    const count = (sql, ...p) => db.get(sql, ...p).n;
    const teams = db.all('SELECT * FROM teams ORDER BY start_date DESC').map((t) => gameFacts(T.summary(db, t, day)));
    const warnings = [];
    if (!app.mailer.isConfigured()) {
      warnings.push(config.demo.enabled
        ? { level: 'info', text: 'Demo mode keeps every email in the outbox instead of sending it. Set up the mail relay only if you want to try a real test email.', link: '#/admin/email' }
        : { level: 'error', text: 'The mail relay is not set up, so nobody can get a sign-in code or notification.', link: '#/admin/email' });
    }
    const admin = db.get("SELECT * FROM users WHERE username = 'admin' COLLATE NOCASE AND password_hash IS NOT NULL");
    if (admin && admin.must_change_password && !config.demo.enabled) warnings.push({ level: 'error', text: 'The admin account still has its first password.', link: '#/password' });
    if (!app.publicUrl()) warnings.push({ level: 'warn', text: 'No public address is set (SANTA_BASE_URL), so links in emails may be wrong.', link: '#/admin/email' });
    const queued = count("SELECT COUNT(*) AS n FROM outbox WHERE status = 'queued'");
    const failed = count("SELECT COUNT(*) AS n FROM outbox WHERE status = 'failed'");
    if (failed) warnings.push({ level: 'warn', text: `${failed} email${failed === 1 ? '' : 's'} could not be sent.`, link: '#/admin/outbox' });
    return {
      counts: {
        users: count('SELECT COUNT(*) AS n FROM users WHERE active = 1'),
        locations: count('SELECT COUNT(*) AS n FROM locations'),
        teams: teams.length,
        gifts: count('SELECT COUNT(*) AS n FROM gifts'),
        tasks: count('SELECT COUNT(*) AS n FROM tasks'),
        tasksDone: count("SELECT COUNT(*) AS n FROM tasks WHERE status = 'done'"),
        wishes: count('SELECT COUNT(*) AS n FROM wishlist_items'),
        queued,
        failed,
      },
      teams,
      warnings,
      demo: config.demo.enabled,
    };
  }, A);

  // ---- users -----------------------------------------------------------------------
  const userRow = (u) => ({
    id: u.id,
    name: displayName(u),
    username: u.username,
    displayName: u.display_name,
    externalId: u.external_id,
    email: u.email,
    locationId: u.location_id,
    locationName: u.location_name,
    role: u.role,
    active: Boolean(u.active),
    hasPassword: Boolean(u.password_hash),
    dnd: Boolean(u.dnd),
    source: u.source,
    lastLoginAt: u.last_login_at,
    createdAt: u.created_at,
  });

  const USER_SQL = `
    SELECT u.*, l.name AS location_name
      FROM users u LEFT JOIN locations l ON l.id = u.location_id`;

  router.get('/api/admin/users', (ctx) => {
    const q = String(ctx.query.q || '').trim();
    const where = [];
    const args = [];
    if (q) {
      where.push("(u.username LIKE ? OR u.display_name LIKE ? OR u.email LIKE ? OR u.external_id LIKE ? OR l.name LIKE ?)");
      const like = `%${q.replace(/[%_]/g, '')}%`;
      args.push(like, like, like, like, like);
    }
    if (ctx.query.locationId) {
      where.push('u.location_id = ?');
      args.push(id(ctx.query.locationId));
    }
    const sql = `${USER_SQL} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY u.active DESC, COALESCE(NULLIF(u.display_name, ''), u.username) COLLATE NOCASE LIMIT 2000`;
    return db.all(sql, ...args).map(userRow);
  }, A);

  function saveUser(ctx, existing) {
    const b = ctx.body;
    const f = U.validateProfileFields(b, { requireEmail: !(existing && existing.password_hash) });
    const loc = optionalId(b.locationId, 'Location');
    if (loc && !db.get('SELECT 1 FROM locations WHERE id = ?', loc)) throw fail(400, 'Unknown location');
    const role = oneOf(b.role, 'Role', ['user', 'admin'], existing ? existing.role : 'user');
    const active = b.active === undefined ? (existing ? existing.active : 1) : (bool(b.active) ? 1 : 0);
    if (existing && existing.id === ctx.user.id && (role !== 'admin' || !active)) throw fail(400, "You can't remove your own admin rights or deactivate yourself");
    if (existing && (existing.email || '') !== (f.email || '')) {
      const secret = T.secretGames(db, existing.id);
      if (secret.length) throw fail(409, `${existing.username} is in the Santa circle of ${secret.map((t) => t.name).join(', ')}. Changing their email would let someone else sign in as them and see their match, so it waits until the Santas are revealed.`);
    }
    if (existing && role === 'admin' && existing.role !== 'admin') {
      const games = db.all(`SELECT DISTINCT t.name FROM teams t LEFT JOIN team_members tm ON tm.team_id = t.id AND tm.user_id = ?
                             WHERE (t.owner_id = ? OR tm.user_id IS NOT NULL) AND t.end_date >= ?`, existing.id, existing.id, today());
      if (games.length) throw fail(409, `${existing.username} is in ${games.map((g) => g.name).join(', ')}. Admin accounts can't be in games, so give them a separate admin account instead.`);
    }
    const clash = db.get('SELECT id, username FROM users WHERE (email = ? OR (external_id IS NOT NULL AND external_id = ?)) AND id <> ?',
      f.email || '', f.externalId || '', existing ? existing.id : 0);
    if (clash) throw fail(409, `That email or ID already belongs to ${clash.username}`);
    const at = nowIso();
    let uid;
    try {
      if (existing) {
        db.run(`UPDATE users SET username = ?, display_name = ?, external_id = ?, email = ?, location_id = ?, role = ?, active = ?, updated_at = ? WHERE id = ?`,
          f.username, f.displayName, f.externalId, f.email, loc, role, active, at, existing.id);
        uid = existing.id;
        if (!active) db.run('DELETE FROM sessions WHERE user_id = ?', uid);
      } else {
        uid = db.run(`INSERT INTO users (username, display_name, external_id, email, location_id, role, active, source, created_at, updated_at)
                      VALUES (?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?)`, f.username, f.displayName, f.externalId, f.email, loc, role, active, at, at).lastInsertRowid;
      }
    } catch (err) {
      if (/UNIQUE/.test(err.message)) throw fail(409, 'Another account already uses that name for password sign-in');
      throw err;
    }
    app.audit(ctx, existing ? 'updated a person' : 'added a person', `${f.username} <${f.email || '-'}>`);
    return userRow(db.get(`${USER_SQL} WHERE u.id = ?`, uid));
  }

  router.post('/api/admin/users', (ctx) => saveUser(ctx, null), A);

  router.put('/api/admin/users/:userId', (ctx) => {
    const u = db.get('SELECT * FROM users WHERE id = ?', id(ctx.params.userId));
    if (!u) throw fail(404, 'No such person');
    return saveUser(ctx, u);
  }, A);

  router.delete('/api/admin/users/:userId', (ctx) => {
    const u = db.get('SELECT * FROM users WHERE id = ?', id(ctx.params.userId));
    if (!u) throw fail(404, 'No such person');
    if (u.id === ctx.user.id) throw fail(400, "You can't delete yourself");
    // How their circles were repaired names who was paired with whom: not for the admin.
    // An organiser left with someone unmatched sees it on their own game.
    U.deleteUser(db, u.id);
    app.audit(ctx, 'deleted a person', `${u.username} <${u.email || '-'}>`);
    return { ok: true };
  }, A);

  router.post('/api/admin/users/:userId/password', (ctx) => {
    const u = db.get('SELECT * FROM users WHERE id = ?', id(ctx.params.userId));
    if (!u) throw fail(404, 'No such person');
    const pw = String(ctx.body.password || '');
    if (!pw) {
      if (u.id === ctx.user.id) throw fail(400, "You can't remove your own password here");
      db.run('UPDATE users SET password_hash = NULL, must_change_password = 0, updated_at = ? WHERE id = ?', nowIso(), u.id);
      app.audit(ctx, 'removed a password', u.username);
      return { ok: true };
    }
    if (pw.length < 8) throw fail(400, 'Use at least 8 characters');
    if (u.id !== ctx.user.id) {
      const secret = T.secretGames(db, u.id);
      if (secret.length) throw fail(409, `${u.username} is in the Santa circle of ${secret.map((t) => t.name).join(', ')}. Setting their password would let someone else sign in as them and see their match, so it waits until the Santas are revealed - they can sign in with an email code meanwhile.`);
    }
    try {
      db.run('UPDATE users SET password_hash = ?, must_change_password = 1, updated_at = ? WHERE id = ?', hashPassword(pw), nowIso(), u.id);
    } catch (err) {
      if (/UNIQUE/.test(err.message)) throw fail(409, `Another account called ${u.username} already signs in with a password`);
      throw err;
    }
    db.run('DELETE FROM sessions WHERE user_id = ?', u.id);
    app.audit(ctx, 'set a password', u.username);
    return { ok: true };
  }, A);

  router.post('/api/admin/users/import', (ctx) => {
    const csv = String(ctx.body.csv || '');
    const opts = { createLocations: ctx.body.createLocations !== false };
    if (!bool(ctx.body.commit)) return U.plan(db, csv, opts);
    const result = U.commit(db, csv, opts);
    app.audit(ctx, 'imported people from CSV', `${result.summary.create} new, ${result.summary.update} updated, ${result.summary.error} skipped`);
    return result;
  }, { auth: 'admin', bodyLimit: 8 * 1024 * 1024 });

  router.get('/api/admin/users/export.csv', (ctx) => {
    const rows = db.all(`${USER_SQL} ORDER BY u.username COLLATE NOCASE`).map(userRow);
    const body = toCsv([
      ['userName', 'ID', 'email', 'displayName', 'location', 'role', 'active', 'lastLogin'],
      ...rows.map((u) => [u.username, u.externalId || '', u.email || '', u.displayName || '', u.locationName || '', u.role, u.active ? 'yes' : 'no', u.lastLoginAt || '']),
    ]);
    sendText(ctx.res, 200, body, 'text/csv; charset=utf-8', { 'content-disposition': 'attachment; filename="secret-santa-people.csv"' });
  }, A);

  // ---- locations -----------------------------------------------------------------------
  router.get('/api/admin/locations', () => db.all(`
    SELECT l.id, l.name, l.created_at AS createdAt,
           (SELECT COUNT(*) FROM users u WHERE u.location_id = l.id AND u.active = 1) AS people
      FROM locations l ORDER BY l.name COLLATE NOCASE`), A);

  router.post('/api/admin/locations', (ctx) => {
    const name = text(ctx.body.name, { field: 'Location', max: 80, required: true });
    try {
      db.run('INSERT INTO locations (name, created_at) VALUES (?, ?)', name, nowIso());
    } catch (err) {
      if (/UNIQUE/.test(err.message)) throw fail(409, `${name} already exists`);
      throw err;
    }
    app.audit(ctx, 'added a location', name);
    return { ok: true };
  }, A);

  router.put('/api/admin/locations/:locId', (ctx) => {
    const name = text(ctx.body.name, { field: 'Location', max: 80, required: true });
    try {
      const r = db.run('UPDATE locations SET name = ? WHERE id = ?', name, id(ctx.params.locId));
      if (!r.changes) throw fail(404, 'No such location');
    } catch (err) {
      if (/UNIQUE/.test(err.message)) throw fail(409, `${name} already exists`);
      throw err;
    }
    app.audit(ctx, 'renamed a location', name);
    return { ok: true };
  }, A);

  router.delete('/api/admin/locations/:locId', (ctx) => {
    const locId = id(ctx.params.locId);
    const loc = db.get('SELECT * FROM locations WHERE id = ?', locId);
    if (!loc) throw fail(404, 'No such location');
    const drawn = db.get(`SELECT t.name FROM team_members tm JOIN teams t ON t.id = tm.team_id JOIN users u ON u.id = tm.user_id
      WHERE t.drawn_at IS NOT NULL AND (tm.location_id = ? OR tm.pool_location_id = ? OR (tm.location_id IS NULL AND u.location_id = ?)) LIMIT 1`, locId, locId, locId);
    if (drawn) throw fail(409, `${loc.name} is used by ${drawn.name}, which has already been drawn`);
    db.run('DELETE FROM locations WHERE id = ?', locId);
    app.audit(ctx, 'deleted a location', loc.name);
    return { ok: true };
  }, A);

  // ---- games (platform view) ---------------------------------------------------------------
  // The list of every game and who runs it. No draw, no Santa list, no players' data here.
  router.get('/api/admin/games', () => db.all('SELECT * FROM teams ORDER BY created_at DESC').map((t) => gameFacts(T.summary(db, t))), A);

  router.put('/api/admin/games/:teamId/owner', (ctx) => {
    const team = T.getTeam(db, id(ctx.params.teamId, 'game'));
    const uid = id(ctx.body.userId, 'New owner');
    const u = db.get('SELECT * FROM users WHERE id = ? AND active = 1', uid);
    if (!u) throw fail(400, 'Pick an active person as the new owner');
    // The platform admin runs the platform, not games: an organiser sees the
    // whole Santa list, so an admin account can never be handed one - and a game
    // with players only goes to one of them, so the admin cannot invent an
    // account to take it over either.
    if (u.role === 'admin') throw fail(400, 'An admin account cannot organise a game - pick a player');
    const hasPlayers = db.get('SELECT 1 FROM team_members WHERE team_id = ? AND opted_out = 0 LIMIT 1', team.id);
    if (hasPlayers && !db.get('SELECT 1 FROM team_members WHERE team_id = ? AND user_id = ? AND opted_out = 0', team.id, uid)) {
      throw fail(400, 'This game has players, so it can only go to someone who plays in it');
    }
    // A new owner who also plays has not accepted the spoiler: ask them again.
    const plays = db.get('SELECT 1 FROM team_members WHERE team_id = ? AND user_id = ?', team.id, uid);
    db.run('UPDATE teams SET owner_id = ?, owner_ack_at = NULL, updated_at = ? WHERE id = ?', uid, nowIso(), team.id);
    app.audit(ctx, 'handed a game to a new owner', `${team.name} -> ${displayName(u)}${plays ? ' (who plays in it)' : ''}`);
    return { ok: true };
  }, A);

  router.delete('/api/admin/games/:teamId', (ctx) => {
    const team = T.getTeam(db, id(ctx.params.teamId, 'game'));
    db.run('DELETE FROM teams WHERE id = ?', team.id);
    app.audit(ctx, 'deleted a game (platform)', team.name);
    return { ok: true };
  }, A);


  // ---- settings ------------------------------------------------------------------------
  router.get('/api/admin/settings', () => ({
    general: app.settings.read('general'),
    email: app.settings.read('email'),
    auth: app.settings.read('auth'),
    guidelines: app.settings.read('guidelines'),
    notifications: app.settings.read('notifications'),
    azure: app.azure.status(),
    saml: app.saml.status(),
    effectiveBaseUrl: app.publicUrl(),
    envBaseUrl: config.baseUrl,
    demo: config.demo.enabled,
  }), A);

  router.put('/api/admin/settings/general', (ctx) => {
    const b = ctx.body;
    let baseUrl = text(b.baseUrl, { field: 'Public address', max: 300 }).replace(/\/+$/, '');
    if (baseUrl && !/^https?:\/\/[^/\s]+/i.test(baseUrl)) throw fail(400, 'The public address must start with http:// or https://');
    if (baseUrl) baseUrl = new URL(baseUrl).origin + new URL(baseUrl).pathname.replace(/\/+$/, '');
    const out = app.settings.write('general', {
      appTitle: text(b.appTitle, { field: 'App title', max: 60 }) || 'Secret Santa',
      baseUrl,
    });
    app.audit(ctx, 'changed general settings');
    return out;
  }, A);

  router.put('/api/admin/settings/email', (ctx) => {
    const b = ctx.body;
    const host = text(b.host, { field: 'Relay host', max: 255 });
    if (host && !/^[A-Za-z0-9.-]+$|^\[[0-9a-fA-F:.]+\]$/.test(host)) throw fail(400, 'The relay host should be a host name or IP address');
    const fromEmail = normEmail(b.fromEmail);
    if (fromEmail && !isEmail(fromEmail)) throw fail(400, 'The From address is not a valid email address');
    const replyTo = normEmail(b.replyTo);
    if (replyTo && !isEmail(replyTo)) throw fail(400, 'The Reply-To address is not a valid email address');
    const out = app.settings.write('email', {
      host,
      port: int(b.port, 'Port', { min: 1, max: 65535, fallback: 25 }),
      security: oneOf(b.security, 'Security', ['none', 'starttls', 'tls'], 'none'),
      allowInvalidCert: bool(b.allowInvalidCert),
      fromName: text(b.fromName, { field: 'From name', max: 80 }),
      fromEmail,
      replyTo,
    });
    app.audit(ctx, 'changed the mail relay', `${host}:${out.port}`);
    app.mailer.kick();
    return out;
  }, A);

  router.post('/api/admin/settings/email/test', async (ctx) => {
    const to = normEmail(ctx.body.to);
    if (!isEmail(to)) throw fail(400, 'Enter the address to send the test to');
    app.auth.limit(`mail-test:${ctx.user.id}`, 10, 600e3);
    const m = emails.test({ appTitle: app.settings.read('general').appTitle, link: app.publicUrl() });
    try {
      const info = await app.mailer.sendNow({ to, subject: m.subject, html: m.html, text: m.text });
      app.mailer.record({ to, kind: 'test', ...m }, 'sent');
      app.audit(ctx, 'sent a test email', to);
      return { ok: true, message: `Sent. The relay answered: ${String(info.response || 'OK').slice(0, 200)}` };
    } catch (err) {
      app.mailer.record({ to, kind: 'test', ...m }, 'failed', String(err.message).slice(0, 500));
      return { ok: false, message: `Could not send: ${err.message}` };
    }
  }, A);

  router.put('/api/admin/settings/auth', (ctx) => {
    const b = ctx.body;
    const domains = text(b.signupDomains, { field: 'Sign-up domains', max: 500 }).toLowerCase()
      .split(/[\s,;]+/).map((d) => d.replace(/^@/, '')).filter(Boolean);
    for (const d of domains) if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d)) throw fail(400, `"${d}" is not a domain name`);
    const out = app.settings.write('auth', {
      otpEnabled: bool(b.otpEnabled),
      azureEnabled: bool(b.azureEnabled),
      azureAutoProvision: bool(b.azureAutoProvision),
      selfSignup: bool(b.selfSignup),
      signupDomains: domains.join(', '),
    });
    app.audit(ctx, 'changed sign-in settings');
    return out;
  }, A);

  router.post('/api/admin/settings/azure/test', () => app.azure.test(), A);

  // ---- SAML: upload / paste / fetch the IdP metadata and configure from it ----------
  router.post('/api/admin/saml/metadata', async (ctx) => {
    const xml = typeof ctx.body.xml === 'string' ? ctx.body.xml : '';
    const url = typeof ctx.body.url === 'string' ? ctx.body.url : '';
    if (!xml && !url) throw fail(400, 'Upload the metadata XML file, paste it, or give its URL');
    let r;
    try {
      r = await app.saml.configure({ xml, url });
    } catch (err) {
      throw fail(400, err.message);
    }
    app.audit(ctx, 'configured SAML sign-in from metadata', `${r.entityId} (${r.certs.length} certificate${r.certs.length === 1 ? '' : 's'})`);
    return r.status;
  }, { auth: 'admin', bodyLimit: 3 * 1024 * 1024 });

  router.put('/api/admin/saml', (ctx) => {
    const b = ctx.body;
    const emailAttribute = text(b.emailAttribute, { field: 'Email claim', max: 300 });
    app.settings.write('saml', {
      enabled: bool(b.enabled),
      emailAttribute,
      buttonLabel: text(b.buttonLabel, { field: 'Button label', max: 60 }) || 'Sign in with Microsoft',
    });
    app.audit(ctx, 'changed SAML settings', bool(b.enabled) ? 'on' : 'off');
    return app.saml.status();
  }, A);

  router.delete('/api/admin/saml', (ctx) => {
    app.settings.write('saml', { ...app.settings.DEFAULTS.saml });
    app.audit(ctx, 'removed the SAML configuration');
    return app.saml.status();
  }, A);

  router.put('/api/admin/settings/guidelines', (ctx) => {
    const out = app.settings.write('guidelines', { text: text(ctx.body.text, { field: 'Guidelines', max: 20000, multiline: true }) });
    app.audit(ctx, 'updated the guidelines');
    return out;
  }, A);

  router.put('/api/admin/settings/notifications', (ctx) => {
    const vals = {};
    for (const k of Object.keys(app.settings.DEFAULTS.notifications)) vals[k] = bool(ctx.body[k]);
    const out = app.settings.write('notifications', vals);
    app.audit(ctx, 'changed notification settings');
    return out;
  }, A);

  // ---- outbox, previews, audit -------------------------------------------------------
  router.get('/api/admin/outbox', (ctx) => {
    const status = ctx.query.status;
    const rows = status
      ? db.all('SELECT id, to_email, to_name, subject, kind, status, attempts, error, created_at, sent_at FROM outbox WHERE status = ? ORDER BY id DESC LIMIT 300', status)
      : db.all('SELECT id, to_email, to_name, subject, kind, status, attempts, error, created_at, sent_at FROM outbox ORDER BY id DESC LIMIT 300');
    const counts = Object.fromEntries(db.all('SELECT status, COUNT(*) AS n FROM outbox GROUP BY status').map((r) => [r.status, r.n]));
    return {
      counts,
      rows: rows.map((r) => {
        const sealed = isSealed(r.kind);
        return {
          id: r.id,
          to: sealed ? '' : r.to_email,
          toName: sealed ? '' : r.to_name,
          subject: r.subject,
          kind: r.kind,
          status: r.status,
          attempts: r.attempts,
          // A relay's error text often quotes the address it refused.
          error: sealed ? r.error.replace(/[^\s<>"']+@[^\s<>"']+/g, '(address hidden)') : r.error,
          createdAt: r.created_at,
          sentAt: r.sent_at,
          sealed,
        };
      }),
    };
  }, A);

  // Shown in a sandboxed frame: no scripts, nothing fetched from outside.
  const EMAIL_FRAME_HEADERS = {
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'self'; sandbox",
    'x-frame-options': 'SAMEORIGIN',
  };

  router.get('/api/admin/outbox/:mailId/html', (ctx) => {
    const r = db.get('SELECT html, kind FROM outbox WHERE id = ?', id(ctx.params.mailId));
    if (!r) throw fail(404, 'No such email');
    // A game email can name someone's Secret Santa child: its body is not for the admin.
    if (isSealed(r.kind)) {
      r.html = `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui,sans-serif;padding:24px;line-height:1.5;color:#333">
        <h2 style="margin:0 0 8px">🔒 Sealed</h2>
        <p>Game emails could give away who is whose Santa, so who received them and what they say are never shown here - not even to an admin.
        This list still shows that each one exists and whether it was delivered.</p>
        <p>To see what an email looks like, use the previews on the <b>Email</b> page, which fill each template with made-up names.</p></body>`;
    }
    ctx.res.removeHeader('content-security-policy');
    ctx.res.removeHeader('x-frame-options');
    sendText(ctx.res, 200, r.html, 'text/html; charset=utf-8', EMAIL_FRAME_HEADERS);
  }, A);

  router.post('/api/admin/outbox/retry', (ctx) => {
    const n = db.run("UPDATE outbox SET status = 'queued', attempts = 0, error = '' WHERE status = 'failed'").changes;
    app.mailer.kick();
    app.audit(ctx, 'retried failed emails', String(n));
    return { retried: n };
  }, A);

  router.delete('/api/admin/outbox', (ctx) => {
    const n = db.run("DELETE FROM outbox WHERE status IN ('sent', 'captured', 'failed')").changes;
    app.audit(ctx, 'cleared the email log', String(n));
    return { deleted: n };
  }, A);

  router.get('/api/admin/email-preview/:kind', (ctx) => {
    const m = emails.sample(ctx.params.kind, { appTitle: app.settings.read('general').appTitle, link: app.publicUrl() || 'https://santa.example' });
    if (!m) throw fail(404, 'No such template');
    ctx.res.removeHeader('content-security-policy');
    ctx.res.removeHeader('x-frame-options');
    sendText(ctx.res, 200, m.html, 'text/html; charset=utf-8', EMAIL_FRAME_HEADERS);
  }, A);

  router.get('/api/admin/audit', () => db.all('SELECT id, actor_name AS actor, action, detail, created_at AS createdAt FROM audit_log ORDER BY id DESC LIMIT 500'), A);

  // ---- demo ----------------------------------------------------------------------------
  router.post('/api/admin/demo/reset', (ctx) => {
    if (!config.demo.enabled) throw fail(404, 'Not found');
    require('../demo').seed(app, { reset: true });
    app.auth.endSession(ctx);
    return { ok: true };
  }, A);

};
