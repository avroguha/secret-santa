import { api, html, mount, actions, avatar, toast, errorText, formValues } from '../lib.js';
import { tree, msLogo } from '../art.js';
import { loadSession, state } from '../app.js';

const ERRORS = {
  'not-invited': (d) => `Your Microsoft account${d ? ` (${d})` : ''} is not on the guest list yet. Ask your admin to add you, then try again.`,
  inactive: () => 'Your account has been switched off. Ask your admin if that looks wrong.',
  azure: (d) => `Microsoft sign-in did not work${d ? `: ${d}` : ''}.`,
};

export async function loginView(main, { query, session }) {
  const s = session;
  let step = 'email';
  let email = '';
  let personas = [];
  if (s.demo.enabled) personas = await api.get('/api/demo/personas').catch(() => []);

  const draw = (error = '') => {
    const sso = s.signIn.sso;
    const otp = s.signIn.otp;
    mount(main, html`
      <div class="login-wrap">
        <div class="login-art">
          ${tree}
          <h1>Who's your Secret Santa?</h1>
          <p>Draw names, swap wishlists, leave little surprises and set silly tasks - all without giving the game away. 🤫</p>
        </div>
        <div class="card login-card ribbon">
          <div class="card-body">
            <h2>Sign in to the workshop</h2>
            ${error ? html`<div class="alert error"><span class="ico">⚠️</span><div>${error}</div></div>` : ''}
            ${sso ? html`<a class="btn ms block big" href="${sso.url}">${msLogo} ${sso.label}</a>` : ''}
            ${sso && otp ? html`<div class="or">or get a code by email</div>` : ''}
            ${otp && step === 'email' ? html`
              <form id="email-form" novalidate>
                <div class="field">
                  <label for="email">Your email address</label>
                  ${s.signIn.selfSignup ? html`<div class="hint" style="margin:-2px 0 8px">New here? Just enter your email - you'll get a code and you're in. ✨</div>` : ''}
                  <input id="email" name="email" type="email" autocomplete="email" required value="${email}" placeholder="you@example.com">
                </div>
                <button class="btn red block" type="submit">✉️ Email me a code</button>
              </form>` : ''}
            ${otp && step === 'code' ? html`
              <form id="code-form" novalidate>
                <p>We sent a sign-in code to <b>${email}</b> (if it is on the list). It melts in 10 minutes. ❄️</p>
                <div class="field">
                  <label for="code">Sign-in code</label>
                  <input id="code" name="code" class="code-input" inputmode="numeric" autocomplete="one-time-code" maxlength="8" required placeholder="••••••">
                </div>
                <button class="btn red block" type="submit">🎅 Sign in</button>
                <div class="row between" style="margin-top:10px">
                  <button class="btn link" type="button" data-act="other-email">Use another email</button>
                  <button class="btn link" type="button" data-act="resend">Send a new code</button>
                </div>
              </form>` : ''}
            ${!sso && !otp ? html`<div class="alert info"><span class="ico">🧝</span><div>Sign-in for players is not set up yet. Admins: sign in below and set up the mail relay or Microsoft sign-in.</div></div>` : ''}
            <details style="margin-top:16px" ${!sso && !otp ? 'open' : ''}>
              <summary class="muted" style="cursor:pointer">Admin sign-in with a password</summary>
              <form id="pw-form" style="margin-top:12px" novalidate>
                <div class="field"><label for="username">Username</label><input id="username" name="username" autocomplete="username" required></div>
                <div class="field"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required></div>
                <button class="btn block" type="submit">🔑 Sign in</button>
              </form>
            </details>
          </div>
        </div>
      </div>
      ${s.demo.enabled && personas.length ? html`
        <div class="card" style="margin-top:22px">
          <div class="card-title"><h2>🧪 Play as anyone</h2><span class="badge gold">demo</span></div>
          <p class="muted">Demo mode: pick a person to sign in as them straight away (the code is always <b>${s.demo.otp}</b>). Holly Berry is in all three games; Noelle Winters is also an admin.</p>
          <div class="grid cards">
            ${personas.map((p) => html`
              <button class="persona" data-act="persona" data-email="${p.email}">
                ${avatar(p.name)}
                <span><b>${p.name}</b>${p.role === 'admin' ? html` <span class="badge gold">admin</span>` : ''}
                <span class="meta">${p.location || 'no location'} · ${p.teams || 'no team yet'}</span></span>
              </button>`)}
          </div>
        </div>` : ''}`);
    bind();
  };

  const signedIn = async (user) => {
    await loadSession();
    toast(`Welcome back, ${user.name.split(' ')[0]}! 🎄`, 'ok');
    let after = '';
    try {
      after = sessionStorage.getItem('santa.after') || '';
      sessionStorage.removeItem('santa.after');
    } catch { /* storage unavailable */ }
    location.hash = state.session.user.mustChangePassword && !s.demo.enabled ? '#/password' : (after || '#/');
  };

  const requestCode = async () => {
    await api.post('/api/auth/otp/request', { email });
    step = 'code';
    draw();
  };

  function bind() {
    const ef = main.querySelector('#email-form');
    if (ef) {
      ef.addEventListener('submit', async (e) => {
        e.preventDefault();
        email = formValues(ef).email.trim();
        if (!email) return;
        try { await requestCode(); } catch (err) { draw(errorText(err)); }
      });
    }
    const cf = main.querySelector('#code-form');
    if (cf) {
      cf.addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
          const r = await api.post('/api/auth/otp/verify', { email, code: formValues(cf).code });
          await signedIn(r.user);
        } catch (err) {
          draw(errorText(err));
        }
      });
      cf.querySelector('#code').focus();
    }
    const pf = main.querySelector('#pw-form');
    pf.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const r = await api.post('/api/auth/password', formValues(pf));
        await signedIn(r.user);
      } catch (err) {
        draw(errorText(err));
        main.querySelector('details').open = true;
      }
    });
  }

  actions(main, {
    'other-email': () => { step = 'email'; draw(); },
    resend: async () => {
      try {
        await requestCode();
        toast('A fresh code is on its way ✉️');
      } catch (err) {
        draw(errorText(err));
      }
    },
    persona: async (d) => {
      email = d.email;
      await api.post('/api/auth/otp/request', { email }).catch(() => {});
      const r = await api.post('/api/auth/otp/verify', { email, code: s.demo.otp });
      await signedIn(r.user);
    },
  });

  const errFn = ERRORS[query.error];
  draw(errFn ? errFn(query.detail) : '');
}

export async function passwordView(main, { session }) {
  const u = session.user;
  if (!u.hasPassword) {
    mount(main, html`<div class="card empty"><span class="big-emoji">🔑</span><h2>No password needed</h2><p>You sign in with an email code or Microsoft.</p><a class="btn" href="#/">Back home</a></div>`);
    return;
  }
  const forced = u.mustChangePassword && !session.demo.enabled;
  mount(main, html`
    <div class="card" style="max-width:520px;margin:0 auto">
      <h1>🔑 ${forced ? 'Choose a new password' : 'Change your password'}</h1>
      ${forced ? html`<div class="alert warn"><span class="ico">🎅</span><div>You signed in with the starting password (admin / admin). Pick a new one before you do anything else - the elves insist.</div></div>` : ''}
      <form id="pw" novalidate>
        <div class="field"><label for="cur">Current password</label><input id="cur" name="current" type="password" autocomplete="current-password" required></div>
        <div class="field"><label for="nw">New password</label><input id="nw" name="next" type="password" autocomplete="new-password" minlength="8" required><div class="hint">At least 8 characters.</div></div>
        <div class="field"><label for="nw2">New password again</label><input id="nw2" name="again" type="password" autocomplete="new-password" required></div>
        <div class="alert error" data-err hidden></div>
        <div class="form-actions">${forced ? '' : html`<a class="btn ghost" href="#/">Cancel</a>`}<button class="btn" type="submit">Save password</button></div>
      </form>
    </div>`);
  const form = main.querySelector('#pw');
  const err = main.querySelector('[data-err]');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = formValues(form);
    err.hidden = true;
    if (v.next !== v.again) {
      err.textContent = 'The two new passwords are different';
      err.hidden = false;
      return;
    }
    try {
      await api.post('/api/auth/change-password', { current: v.current, next: v.next });
      await loadSession();
      toast('Password changed 🔒', 'ok');
      location.hash = u.role === 'admin' ? '#/admin' : '#/';
    } catch (ex) {
      err.textContent = errorText(ex);
      err.hidden = false;
    }
  });
}
