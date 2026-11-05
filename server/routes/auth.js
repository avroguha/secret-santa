'use strict';
const { fail, today, text, isEmail, nowIso, hashPassword, verifyPassword, displayName } = require('../lib/util');
const { serializeCookie, appendCookie, redirect, sendText } = require('../lib/http');

const OIDC_COOKIE = 'ss_oidc';

module.exports = function authRoutes(router, app) {
  const { db, config, auth, azure } = app;

  router.get('/api/session', (ctx) => {
    const general = app.settings.read('general');
    return {
      user: ctx.user ? auth.publicUser(ctx.user) : null,
      appTitle: general.appTitle,
      today: today(),
      version: config.version,
      demo: config.demo.enabled ? { enabled: true, otp: config.demo.otp } : { enabled: false },
      signIn: {
        // One "Sign in with Microsoft" button: SAML when it is set up, else OpenID Connect.
        sso: app.saml.available()
          ? { url: '/auth/saml/login', label: app.settings.read('saml').buttonLabel || 'Sign in with Microsoft' }
          : azure.available() ? { url: '/auth/azure/login', label: 'Sign in with Microsoft' } : null,
        azure: azure.available() || app.saml.available(),
        otp: auth.otpAvailable(),
        selfSignup: auth.otpAvailable() && Boolean(app.settings.read('auth').selfSignup),
        password: true,
      },
    };
  }, { auth: 'none' });

  router.post('/api/auth/otp/request', (ctx) => auth.requestOtp(ctx, ctx.body.email), { auth: 'none' });

  router.post('/api/auth/otp/verify', (ctx) => ({ user: auth.verifyOtp(ctx, ctx.body.email, ctx.body.code) }), { auth: 'none' });

  router.post('/api/auth/password', (ctx) => {
    const user = auth.passwordLogin(ctx, ctx.body.username, String(ctx.body.password || ''));
    app.audit(ctx, 'signed in with a password', '', user);
    return { user };
  }, { auth: 'none' });

  router.post('/api/auth/logout', (ctx) => {
    auth.endSession(ctx);
    return { ok: true };
  }, { auth: 'none' });

  router.post('/api/auth/change-password', (ctx) => {
    const u = ctx.user;
    const next = String(ctx.body.next || '');
    if (!u.password_hash) throw fail(400, 'Your account signs in by email code or Microsoft - it has no password');
    if (!verifyPassword(String(ctx.body.current || ''), u.password_hash)) throw fail(400, 'Your current password is not right');
    if (next.length < 8) throw fail(400, 'Choose a password of at least 8 characters');
    if (next.length > 200) throw fail(400, 'That password is too long');
    if (next.toLowerCase() === 'admin' || next.toLowerCase() === u.username.toLowerCase()) throw fail(400, 'Choose something harder to guess than your username');
    db.run('UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?', hashPassword(next), nowIso(), u.id);
    // Every other session of this account is signed out.
    db.run('DELETE FROM sessions WHERE user_id = ? AND id <> ?', u.id, ctx.session.id);
    app.audit(ctx, 'changed their password');
    return { ok: true };
  }, { allowPasswordChange: true });

  // ---- Microsoft sign-in ----------------------------------------------------
  // The reason goes to the server log; the page gets a fixed code (and, for
  // "not on the list", the address it was tried with). Nothing a third party
  // can put in a link or a forged response ends up as text on the sign-in page.
  const backToLogin = (ctx, code, detail) => {
    appendCookie(ctx.res, serializeCookie(OIDC_COOKIE, '', { httpOnly: true, path: '/auth/azure', maxAge: 0 }));
    const safe = ['not-invited', 'inactive', 'azure'].includes(code) ? code : 'azure';
    const q = new URLSearchParams({ error: safe });
    if (safe === 'not-invited' && detail && isEmail(String(detail))) q.set('detail', String(detail));
    else if (detail) console.error(`single sign-on (${code}): ${String(detail).slice(0, 500)}`);
    redirect(ctx.res, `/#/login?${q}`);
  };

  router.get('/auth/azure/login', async (ctx) => {
    try {
      const { url, state } = await azure.begin(ctx);
      appendCookie(ctx.res, serializeCookie(OIDC_COOKIE, state, {
        httpOnly: true, sameSite: 'Lax', path: '/auth/azure', maxAge: 600, secure: config.cookieSecure || ctx.req.socket.encrypted,
      }));
      redirect(ctx.res, url);
    } catch (err) {
      console.error(`azure login: ${err.message}`);
      backToLogin(ctx, 'azure', err.status === 404 ? 'Microsoft sign-in is not set up.' : err.message);
    }
  }, { auth: 'none' });

  // Who signed in through single sign-on: match by email, then by user principal
  // name; create the account when the admin allows anyone in the tenant.
  function ssoUser(ctx, who, source) {
    const candidates = [who.email, who.username].filter((e) => e && isEmail(e));
    let user = null;
    for (const e of candidates) {
      user = db.get('SELECT * FROM users WHERE email = ?', e);
      if (user) break;
    }
    if (!user && who.username) user = db.get('SELECT * FROM users WHERE username = ? COLLATE NOCASE AND password_hash IS NULL', who.username);
    if (user && !user.active) return { error: 'inactive' };
    if (!user) {
      const email = candidates[0];
      if (!app.settings.read('auth').azureAutoProvision || !email) return { error: 'not-invited', detail: email || who.username };
      const at = nowIso();
      const newId = db.run(
        'INSERT INTO users (username, email, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
        text(who.name, { max: 120 }) || email, email, source, at, at,
      ).lastInsertRowid;
      user = db.get('SELECT * FROM users WHERE id = ?', newId);
      app.audit(ctx, `joined through ${source === 'saml' ? 'SAML' : 'Microsoft'} sign-in`, email, user);
    }
    return { user };
  }

  router.get('/auth/azure/callback', async (ctx) => {
    const q = ctx.query;
    if (q.error) {
      backToLogin(ctx, 'azure', q.error_description || q.error);
      return;
    }
    let who;
    try {
      who = await azure.finish(ctx, { code: q.code, state: q.state, cookieState: ctx.cookies[OIDC_COOKIE] });
    } catch (err) {
      console.error(`azure callback: ${err.message}`);
      backToLogin(ctx, 'azure', err.message);
      return;
    }
    const r = ssoUser(ctx, who, 'azure');
    if (r.error) {
      backToLogin(ctx, r.error, r.detail);
      return;
    }
    const user = r.user;
    appendCookie(ctx.res, serializeCookie(OIDC_COOKIE, '', { httpOnly: true, path: '/auth/azure', maxAge: 0 }));
    auth.startSession(ctx, user, 'azure');
    redirect(ctx.res, '/#/');
  }, { auth: 'none' });

  // ---- SAML ------------------------------------------------------------------------
  router.get('/auth/saml/login', async (ctx) => {
    try {
      redirect(ctx.res, await app.saml.loginUrl());
    } catch (err) {
      console.error(`saml login: ${err.message}`);
      backToLogin(ctx, 'azure', err.message);
    }
  }, { auth: 'none' });

  // The identity provider POSTs the signed response here (a cross-site form
  // post, so no CSRF token - the signature and InResponseTo protect it).
  router.post('/auth/saml/acs', async (ctx) => {
    let who;
    try {
      who = await app.saml.finish(ctx.body);
    } catch (err) {
      console.error(`saml response: ${err.message}`);
      backToLogin(ctx, 'azure', `the SAML response was not accepted (${err.message})`);
      return;
    }
    const r = ssoUser(ctx, who, 'saml');
    if (r.error) {
      backToLogin(ctx, r.error, r.detail);
      return;
    }
    auth.startSession(ctx, r.user, 'saml');
    redirect(ctx.res, '/#/');
  }, { auth: 'none', noCsrf: true, form: true });

  // Our service-provider metadata, to upload into the identity provider.
  router.get('/saml/metadata', (ctx) => {
    sendText(ctx.res, 200, app.saml.spMetadata(), 'application/samlmetadata+xml; charset=utf-8',
      { 'content-disposition': 'inline; filename="secret-santa-sp-metadata.xml"' });
  }, { auth: 'none' });

  // ---- demo helpers -----------------------------------------------------------
  router.get('/api/demo/personas', () => {
    if (!config.demo.enabled) throw fail(404, 'Not found');
    return db.all(`
      SELECT u.id, u.username, u.display_name, u.email, u.role, l.name AS location,
             (SELECT group_concat(t.name, ', ') FROM team_members tm JOIN teams t ON t.id = tm.team_id WHERE tm.user_id = u.id) AS teams
        FROM users u LEFT JOIN locations l ON l.id = u.location_id
       WHERE u.email IS NOT NULL AND u.active = 1
       ORDER BY CASE u.role WHEN 'admin' THEN 0 ELSE 1 END, COALESCE(NULLIF(u.display_name, ''), u.username)`)
      .map((u) => ({ id: u.id, name: displayName(u), email: u.email, role: u.role, location: u.location, teams: u.teams || '' }));
  }, { auth: 'none' });
};
