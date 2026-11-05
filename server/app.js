'use strict';
// Wires the pieces together and handles every request. createApp() does not
// listen on a port, so the tests drive app.handle directly through a server
// of their own.
const net = require('node:net');
const { openDb } = require('./db');
const { Router, parseCookies, readJson, readForm, sendJson, sendText, securityHeaders, serveStatic } = require('./lib/http');
const { HttpError, nowIso, today, addDays, displayName, hashPassword } = require('./lib/util');
const settingsService = require('./services/settings');
const { Mailer } = require('./services/mailer');

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const HOST_RE = /^(?:[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/;

// The seeded account the user asked for: admin / admin. Outside demo mode it
// must be changed at the first sign-in before anything else works.
function seedAdmin(db) {
  if (db.get("SELECT value FROM meta WHERE key = 'admin_seeded'")) return false;
  const at = nowIso();
  if (!db.get("SELECT 1 FROM users WHERE username = 'admin' COLLATE NOCASE AND password_hash IS NOT NULL")) {
    db.run("INSERT INTO users (username, display_name, role, password_hash, must_change_password, source, created_at, updated_at) VALUES ('admin', 'Head Elf (admin)', 'admin', ?, 1, 'seed', ?, ?)",
      hashPassword('admin'), at, at);
  }
  db.run("INSERT INTO meta (key, value) VALUES ('admin_seeded', ?)", at);
  return true;
}

// Locked out? `node server/index.js --reset-admin` puts admin / admin back,
// to be changed at the next sign-in.
function resetAdmin(db) {
  const at = nowIso();
  const u = db.get("SELECT id FROM users WHERE username = 'admin' COLLATE NOCASE AND password_hash IS NOT NULL");
  if (u) {
    db.run("UPDATE users SET password_hash = ?, must_change_password = 1, role = 'admin', active = 1, updated_at = ? WHERE id = ?", hashPassword('admin'), at, u.id);
    db.run('DELETE FROM sessions WHERE user_id = ?', u.id);
  } else {
    db.run("INSERT INTO users (username, display_name, role, password_hash, must_change_password, source, created_at, updated_at) VALUES ('admin', 'Head Elf (admin)', 'admin', ?, 1, 'seed', ?, ?)",
      hashPassword('admin'), at, at);
  }
}

function createApp(config) {
  const db = openDb(config.dbFile);
  const app = { db, config };
  app.settings = settingsService.create(db);

  // Where links in emails point: the admin's setting, else SANTA_BASE_URL, else
  // the address an ADMIN last used. Never a random visitor's Host header - that
  // would let anyone choose where emails link to.
  let adminOrigin = '';
  app.publicUrl = (origin) => app.settings.read('general').baseUrl || config.baseUrl || origin || adminOrigin || '';

  app.mailer = new Mailer(app);
  app.auth = require('./services/auth').create(app);
  app.azure = require('./services/azure').create(app);
  app.saml = require('./services/saml').create(app);
  app.notify = require('./services/notify').create(app);
  app.audit = (ctx, action, detail = '', actor) => {
    const u = actor || (ctx && ctx.user);
    db.run('INSERT INTO audit_log (actor_id, actor_name, action, detail, created_at) VALUES (?, ?, ?, ?, ?)',
      u ? u.id : null, u ? (u.name || displayName(u)) : '', action, String(detail || '').slice(0, 500), nowIso());
  };

  if (config.demo.enabled) require('./demo').seed(app, { reset: config.demo.resetOnStart });
  else seedAdmin(db);

  const router = new Router();
  require('./routes/auth')(router, app);
  require('./routes/me')(router, app);
  require('./routes/teams')(router, app);
  require('./routes/manage')(router, app);
  require('./routes/admin')(router, app);

  const peerIsProxy = (addr) => {
    const a = String(addr || '').replace(/^::ffff:/, '');
    if (a === '127.0.0.1' || a === '::1') return true;
    return net.isIPv4(a) && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a);
  };

  function clientIp(req) {
    const peer = req.socket.remoteAddress || '';
    // Behind Cloudflare / a reverse proxy every request arrives from the proxy;
    // the real address is in a header, trusted only when the proxy sent it.
    if (config.trustProxy && peerIsProxy(peer)) {
      const cf = req.headers['cf-connecting-ip'];
      if (cf && net.isIP(String(cf).trim())) return String(cf).trim();
      const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
      if (xff && net.isIP(xff)) return xff;
    }
    return peer.replace(/^::ffff:/, '');
  }

  function requestOrigin(req) {
    const host = String(req.headers.host || '');
    if (!HOST_RE.test(host)) return '';
    let proto = req.socket.encrypted ? 'https' : 'http';
    if (config.trustProxy && peerIsProxy(req.socket.remoteAddress)) {
      const fp = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
      if (fp === 'https' || fp === 'http') proto = fp;
    }
    return `${proto}://${host}`;
  }

  async function handle(req, res) {
    securityHeaders(res, { tls: Boolean(req.socket.encrypted) });
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      sendText(res, 400, 'Bad request');
      return;
    }
    const p = url.pathname;
    const isApi = p.startsWith('/api/') || p.startsWith('/auth/') || p.startsWith('/saml/');
    try {
      if (p === '/healthz') {
        sendJson(res, 200, { ok: true, version: config.version, demo: config.demo.enabled });
        return;
      }
      if (!isApi) {
        if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
        serveStatic(req, res, config.publicDir, p);
        return;
      }
      const m = router.match(req.method, p);
      if (!m) throw new HttpError(404, 'Not found');
      if (m.methodNotAllowed) throw new HttpError(405, 'Method not allowed');
      const opts = m.route.opts;
      const ctx = {
        req, res, url, params: m.params, query: Object.fromEntries(url.searchParams),
        cookies: parseCookies(req.headers.cookie), ip: clientIp(req), origin: requestOrigin(req),
      };
      app.auth.ensureCsrf(ctx);
      ctx.session = app.auth.loadSession(ctx);
      ctx.user = ctx.session ? ctx.session.user : null;
      if (ctx.user) ctx.user.name = displayName(ctx.user);
      // noCsrf: only the SAML assertion consumer, protected by the signed response itself.
      if (MUTATING.has(req.method) && !opts.noCsrf) app.auth.checkCsrf(ctx);
      const need = opts.auth || 'user';
      if (need !== 'none') {
        if (!ctx.user) throw new HttpError(401, 'Please sign in first', { code: 'signin' });
        if (need === 'admin' && ctx.user.role !== 'admin') throw new HttpError(403, 'Only admins can do that');
        if (ctx.user.must_change_password && !config.demo.enabled && !opts.allowPasswordChange) {
          throw new HttpError(403, 'Choose a new password first', { code: 'password_change_required' });
        }
      }
      if (ctx.user && ctx.user.role === 'admin' && ctx.origin) adminOrigin = ctx.origin;
      if (!MUTATING.has(req.method)) ctx.body = {};
      else ctx.body = opts.form ? await readForm(req, opts.bodyLimit || 1024 * 1024) : await readJson(req, opts.bodyLimit || 256 * 1024);
      const out = await m.route.handler(ctx);
      if (res.headersSent || res.writableEnded) return;
      sendJson(res, 200, out === undefined ? { ok: true } : out);
    } catch (err) {
      const known = err instanceof HttpError;
      const status = known ? err.status : 500;
      if (!known) console.error(`${req.method} ${p}: ${err.stack || err.message}`);
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (isApi) {
        sendJson(res, status, {
          error: known ? err.message : 'Something went wrong on our side - try again, and tell your admin if it keeps happening',
          ...(known && err.details ? { details: err.details } : {}),
        });
      } else {
        sendText(res, status, status === 404 ? 'Not found' : 'Error');
      }
    }
  }
  app.handle = handle;

  // Daily jobs: the "game starts today" email, the reveal after the end date,
  // and clearing out expired sessions and codes.
  function tick() {
    const day = today();
    for (const t of db.all('SELECT * FROM teams WHERE drawn_at IS NOT NULL')) {
      try {
        if (!t.start_notified && day >= t.start_date) {
          if (day <= t.end_date) app.notify.start(t);
          db.run('UPDATE teams SET start_notified = 1 WHERE id = ?', t.id);
        }
        if (!t.reveal_notified && t.reveal_mode === 'after_end' && day > t.end_date) {
          if (day <= addDays(t.end_date, 7)) app.notify.reveal(t);
          db.run('UPDATE teams SET reveal_notified = 1 WHERE id = ?', t.id);
        }
      } catch (err) {
        console.error(`scheduler, team ${t.id}: ${err.message}`);
      }
    }
    // Gentle reminders: check-in (phase 1) and the friendly jingle (phase 2).
    for (const t of db.all('SELECT * FROM teams WHERE end_date >= ?', day)) {
      try {
        for (const r of app.notify.runScheduled(t, day)) {
          app.audit(null, `sent an automatic ${r.kind === 'location' ? 'check-in' : 'gift'} reminder`, `${t.name}: ${r.recipients} email(s), ${r.offset} day(s) before`);
        }
      } catch (err) {
        console.error(`reminders, team ${t.id}: ${err.message}`);
      }
    }
    app.saml.refresh().catch(() => {});
    const now = nowIso();
    db.run('DELETE FROM sessions WHERE expires_at < ?', now);
    db.run('DELETE FROM otp_codes WHERE expires_at < ?', new Date(Date.now() - 86400e3).toISOString());
  }
  app.tick = tick;

  const timers = [];
  app.start = () => {
    app.mailer.start();
    timers.push(setTimeout(tick, 5000), setInterval(tick, 10 * 60e3));
    for (const t of timers) t.unref();
  };
  app.stop = () => {
    for (const t of timers) clearTimeout(t);
    app.mailer.stop();
    db.close();
  };
  return app;
}

module.exports = { createApp, seedAdmin, resetAdmin };
