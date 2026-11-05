'use strict';
// Sessions and the three ways in: Microsoft (Azure Entra ID) single sign-on,
// a one-time code by email, and a local password for the seeded admin.
//
// Sessions are random tokens in an HttpOnly cookie; only their SHA-256 is
// stored, so a copy of the database cannot be replayed as a login.
const { nowIso, randomToken, sha256, safeEqual, verifyPassword, normEmail, isEmail, fail, displayName } = require('../lib/util');
const { serializeCookie, appendCookie } = require('../lib/http');

const SESSION_COOKIE = 'ss_sid';
const CSRF_COOKIE = 'ss_csrf';
const SESSION_DAYS = 7;
const OTP_MINUTES = 10;
const OTP_MAX_ATTEMPTS = 5;
const OTP_BAD_PER_DAY = 15;

// In-memory fixed-window limiter. One process serves the app, so this is enough.
class Limiter {
  constructor() {
    this.hits = new Map();
  }

  take(key, max, windowMs) {
    const now = Date.now();
    let h = this.hits.get(key);
    if (!h || h.reset <= now) {
      h = { count: 0, reset: now + windowMs };
      this.hits.set(key, h);
    }
    h.count += 1;
    if (this.hits.size > 50000) {
      for (const [k, v] of this.hits) if (v.reset <= now) this.hits.delete(k);
    }
    return h.count <= max;
  }

  retryAfter(key) {
    const h = this.hits.get(key);
    return h ? Math.max(1, Math.ceil((h.reset - Date.now()) / 1000)) : 1;
  }

  // How many hits the key has in its current window, without adding one.
  count(key) {
    const h = this.hits.get(key);
    return h && h.reset > Date.now() ? h.count : 0;
  }

  clear(key) {
    this.hits.delete(key);
  }
}

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    name: displayName(u),
    username: u.username,
    displayName: u.display_name,
    email: u.email,
    role: u.role,
    locationId: u.location_id,
    hasPassword: Boolean(u.password_hash),
    mustChangePassword: Boolean(u.must_change_password),
  };
}

function create(app) {
  const { db, config } = app;
  const limiter = new Limiter();

  const secureFor = (ctx) => config.cookieSecure || Boolean(ctx.req.socket.encrypted);

  function ensureCsrf(ctx) {
    let token = ctx.cookies[CSRF_COOKIE];
    if (!token || !/^[A-Za-z0-9_-]{20,}$/.test(token)) {
      token = randomToken(24);
      ctx.cookies[CSRF_COOKIE] = token;
      // Readable by the page (double-submit token), Strict so no other site can send it.
      appendCookie(ctx.res, serializeCookie(CSRF_COOKIE, token, { sameSite: 'Strict', secure: secureFor(ctx), maxAge: 30 * 86400 }));
    }
    return token;
  }

  function checkCsrf(ctx) {
    const sent = ctx.req.headers['x-csrf-token'];
    const cookie = ctx.cookies[CSRF_COOKIE];
    if (!sent || !cookie || !safeEqual(sent, cookie)) throw fail(403, 'Your page is out of date - reload it and try again', { code: 'csrf' });
  }

  function loadSession(ctx) {
    const token = ctx.cookies[SESSION_COOKIE];
    if (!token) return null;
    const id = sha256(token);
    const row = db.get('SELECT * FROM sessions WHERE id = ?', id);
    if (!row) return null;
    const now = new Date();
    if (row.expires_at <= now.toISOString()) {
      db.run('DELETE FROM sessions WHERE id = ?', id);
      return null;
    }
    const user = db.get('SELECT * FROM users WHERE id = ? AND active = 1', row.user_id);
    if (!user) return null;
    // Sliding expiry, written at most once an hour.
    if (now - new Date(row.last_seen_at) > 3600e3) {
      const exp = new Date(now.getTime() + SESSION_DAYS * 86400e3).toISOString();
      db.run('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?', now.toISOString(), exp, id);
    }
    return { id, user, method: row.method };
  }

  function startSession(ctx, user, method) {
    const token = randomToken(32);
    const now = new Date();
    const exp = new Date(now.getTime() + SESSION_DAYS * 86400e3);
    db.run(
      'INSERT INTO sessions (id, user_id, method, created_at, expires_at, last_seen_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      sha256(token), user.id, method, now.toISOString(), exp.toISOString(), now.toISOString(), ctx.ip || '',
      String(ctx.req.headers['user-agent'] || '').slice(0, 300),
    );
    db.run('UPDATE users SET last_login_at = ? WHERE id = ?', now.toISOString(), user.id);
    appendCookie(ctx.res, serializeCookie(SESSION_COOKIE, token, {
      httpOnly: true, sameSite: 'Lax', secure: secureFor(ctx), maxAge: SESSION_DAYS * 86400,
    }));
    return publicUser(db.get('SELECT * FROM users WHERE id = ?', user.id));
  }

  function endSession(ctx) {
    const token = ctx.cookies[SESSION_COOKIE];
    if (token) db.run('DELETE FROM sessions WHERE id = ?', sha256(token));
    appendCookie(ctx.res, serializeCookie(SESSION_COOKIE, '', { httpOnly: true, sameSite: 'Lax', secure: secureFor(ctx), maxAge: 0 }));
  }

  function limit(key, max, windowMs, message) {
    if (!limiter.take(key, max, windowMs)) {
      throw fail(429, message || `Too many attempts - try again in ${limiter.retryAfter(key)} seconds`, { retryAfter: limiter.retryAfter(key) });
    }
  }

  // ---- email one-time code --------------------------------------------------
  function otpAvailable() {
    const s = app.settings.read('auth');
    return Boolean(s.otpEnabled) && (config.demo.enabled || app.mailer.isConfigured());
  }

  // Open sign-up: an address nobody has loaded may sign up with a code, if the
  // admin allows it (and, optionally, only from listed domains).
  function canSignUp(email) {
    const a = app.settings.read('auth');
    if (!a.selfSignup) return false;
    if (db.get('SELECT 1 FROM users WHERE email = ?', email)) return false; // exists (maybe switched off)
    const domains = String(a.signupDomains || '').toLowerCase().split(/[\s,;]+/).filter(Boolean);
    if (!domains.length) return true;
    const host = email.split('@')[1] || '';
    return domains.some((d) => host === d || host.endsWith(`.${d}`));
  }

  function createFromEmail(ctx, email) {
    const local = email.split('@')[0].replace(/[._-]+/g, ' ').trim();
    const name = local.replace(/\b\w/g, (c) => c.toUpperCase()).slice(0, 120) || email;
    const at = nowIso();
    const newId = db.run("INSERT INTO users (username, email, source, created_at, updated_at) VALUES (?, ?, 'signup', ?, ?)", name, email, at, at).lastInsertRowid;
    const user = db.get('SELECT * FROM users WHERE id = ?', newId);
    app.audit(ctx, 'signed up with an email code', email, user);
    return user;
  }

  async function requestOtp(ctx, rawEmail) {
    const email = normEmail(rawEmail);
    if (!isEmail(email)) throw fail(400, 'Enter a valid email address');
    if (!app.settings.read('auth').otpEnabled) throw fail(403, 'Email sign-in is switched off');
    if (!config.demo.enabled && !app.mailer.isConfigured()) {
      throw fail(503, "Email sign-in isn't ready yet - the mail relay has not been set up. Ask your admin.");
    }
    limit(`otp-ip:${ctx.ip}`, 20, 3600e3);
    // The same answer whether or not the address is known, so this cannot be
    // used to find out who is playing.
    const answer = { ok: true, minutes: OTP_MINUTES, message: 'If that address is on the list, a code is on its way.' };
    if (!limiter.take(`otp-send:${email}`, 1, 30e3)) {
      throw fail(429, `A code was sent moments ago - wait ${limiter.retryAfter(`otp-send:${email}`)} seconds before asking again`);
    }
    limit(`otp-hour:${email}`, 6, 3600e3, 'Too many codes asked for this address - try again in an hour');
    const user = db.get('SELECT * FROM users WHERE email = ? AND active = 1', email);
    if (!user && !canSignUp(email)) return answer;

    const appTitle = app.settings.read('general').appTitle;
    const emails = require('./emails');
    if (config.demo.enabled) {
      const msg = emails.otp({ appTitle, name: user ? displayName(user) : '', code: config.demo.otp, minutes: OTP_MINUTES, demo: true });
      app.mailer.record({ to: email, toName: user ? displayName(user) : '', kind: 'otp', ...msg }, 'captured');
      return answer;
    }
    const code = String(require('node:crypto').randomInt(0, 1000000)).padStart(6, '0');
    const salt = randomToken(12);
    const now = new Date();
    db.run('UPDATE otp_codes SET used_at = ? WHERE email = ? AND used_at IS NULL', now.toISOString(), email);
    db.run(
      'INSERT INTO otp_codes (email, code_hash, salt, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
      email, sha256(`${salt}:${code}`), salt, now.toISOString(), new Date(now.getTime() + OTP_MINUTES * 60e3).toISOString(),
    );
    const msg = emails.otp({ appTitle, name: user ? displayName(user) : '', code, minutes: OTP_MINUTES });
    // The outbox keeps a copy with the code blanked out: not even an admin can
    // read someone's live code from the log.
    const redacted = {
      subject: msg.subject.replace(code, '••••••'),
      html: msg.html.split(code).join('••••••').split(code.replace(/(\d{3})(?=\d)/g, '$1 ')).join('••• •••'),
      text: msg.text.split(code).join('••••••'),
    };
    // Sent without waiting: a known address must answer exactly like an
    // unknown one, or the time taken would say who is on the list. A failed
    // send shows in Admin > Outbox and Overview.
    const toName = user ? displayName(user) : '';
    app.mailer.sendNow({ to: email, toName, ...msg })
      .then(() => app.mailer.record({ to: email, toName, kind: 'otp', ...redacted }, 'sent'))
      .catch((err) => {
        app.mailer.record({ to: email, toName, kind: 'otp', ...redacted }, 'failed', String(err.message).slice(0, 500));
        console.error(`otp mail to ${email} failed: ${err.message}`);
      });
    return answer;
  }

  function verifyOtp(ctx, rawEmail, rawCode) {
    const email = normEmail(rawEmail);
    const code = String(rawCode || '').replace(/\s+/g, '');
    if (!isEmail(email) || !/^\d{4,8}$/.test(code)) throw fail(400, 'Enter the code from the email');
    limit(`otp-verify-ip:${ctx.ip}`, 60, 15 * 60e3);
    limit(`otp-verify:${email}`, 10, 15 * 60e3, 'Too many wrong codes - ask for a new one in a few minutes');
    if (limiter.count(`otp-bad-day:${email}`) >= OTP_BAD_PER_DAY) {
      throw fail(429, 'Too many wrong codes for this address today - try again tomorrow, or ask your admin', { retryAfter: limiter.retryAfter(`otp-bad-day:${email}`) });
    }
    const wrong = () => limiter.take(`otp-bad-day:${email}`, Infinity, 86400e3);
    const bad = () => fail(401, "That code didn't work - check it, or ask for a new one");
    const user = db.get('SELECT * FROM users WHERE email = ? AND active = 1', email);
    if (config.demo.enabled) {
      if (!safeEqual(code, config.demo.otp) || (!user && !canSignUp(email))) throw bad();
      return startSession(ctx, user || createFromEmail(ctx, email), 'otp');
    }
    const row = db.get(
      'SELECT * FROM otp_codes WHERE email = ? AND used_at IS NULL AND expires_at > ? ORDER BY id DESC LIMIT 1',
      email, nowIso(),
    );
    if (!row || (!user && !canSignUp(email))) throw bad();
    if (row.attempts >= OTP_MAX_ATTEMPTS) {
      db.run('UPDATE otp_codes SET used_at = ? WHERE id = ?', nowIso(), row.id);
      throw fail(401, 'Too many wrong tries for that code - ask for a new one');
    }
    if (!safeEqual(sha256(`${row.salt}:${code}`), row.code_hash)) {
      db.run('UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?', row.id);
      wrong();
      throw bad();
    }
    db.run('UPDATE otp_codes SET used_at = ? WHERE id = ?', nowIso(), row.id);
    limiter.clear(`otp-verify:${email}`);
    return startSession(ctx, user || createFromEmail(ctx, email), 'otp');
  }

  // ---- local password (the seeded admin, and anyone an admin gives one) ----
  function passwordLogin(ctx, rawUser, password) {
    const username = String(rawUser || '').trim();
    if (!username || !password) throw fail(400, 'Enter your username and password');
    limit(`pw-ip:${ctx.ip}`, 30, 15 * 60e3);
    const key = `pw:${username.toLowerCase()}:${ctx.ip}`;
    const accountKey = `pw:${username.toLowerCase()}`;
    limit(key, 8, 15 * 60e3, 'Too many failed sign-ins for that account - wait 15 minutes');
    limit(accountKey, 40, 15 * 60e3, 'Too many failed sign-ins for that account - wait 15 minutes');
    const user = db.get('SELECT * FROM users WHERE username = ? COLLATE NOCASE AND password_hash IS NOT NULL AND active = 1', username);
    // Verify against a dummy hash when the user is unknown, so timing does not tell.
    const ok = verifyPassword(password, user ? user.password_hash : DUMMY_HASH);
    if (!user || !ok) throw fail(401, 'That username and password do not match');
    limiter.clear(key);
    return startSession(ctx, user, 'password');
  }

  return {
    limiter, limit, ensureCsrf, checkCsrf, loadSession, startSession, endSession,
    otpAvailable, requestOtp, verifyOtp, passwordLogin, publicUser,
  };
}

const DUMMY_HASH = require('../lib/util').hashPassword(randomToken(16));

module.exports = { create, publicUser, Limiter, SESSION_COOKIE, CSRF_COOKIE, OTP_MINUTES };
