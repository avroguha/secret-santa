// App shell: session, header, router.
import { api, html, mount, actions, loading, avatar, showError, toast, installSecrets } from './lib.js';
import { hat } from './art.js';
import { setSnow, snowPreference, saveSnow } from './snow.js';
import { loginView, passwordView } from './views/login.js';
import { homeView } from './views/home.js';
import { teamView } from './views/team.js';
import { wishlistView, profileView } from './views/me.js';
import * as admin from './views/admin.js';
import { manageView } from './views/manage.js';
import { joinView } from './views/join.js';
import { guideView } from './views/guide.js';

export const state = { session: null };

const ROUTES = [
  ['/login', loginView, { public: true }],
  ['/password', passwordView, { allowPasswordChange: true }],
  ['/', homeView, { player: true }],
  ['/team/:id', teamView, { player: true }],
  ['/team/:id/:tab', teamView, { player: true }],
  ['/wishlist', wishlistView, { player: true }],
  ['/profile', profileView],
  ['/guide', guideView],
  ['/manage/:id', manageView, { player: true }],
  ['/manage/:id/:tab', manageView, { player: true }],
  ['/join/:code', joinView, { player: true }],
  ['/admin', admin.overviewView, { admin: true }],
  ['/admin/users', admin.usersView, { admin: true }],
  ['/admin/import', admin.importView, { admin: true }],
  ['/admin/locations', admin.locationsView, { admin: true }],
  ['/admin/games', admin.gamesView, { admin: true }],
  ['/admin/email', admin.emailView, { admin: true }],
  ['/admin/signin', admin.signinView, { admin: true }],
  ['/admin/outbox', admin.outboxView, { admin: true }],
  ['/admin/audit', admin.auditView, { admin: true }],
  ['/admin/guidelines', admin.guidelinesView, { admin: true }],
];

function parseHash() {
  const h = location.hash.replace(/^#/, '') || '/';
  const [path, qs] = h.split('?');
  const query = Object.fromEntries(new URLSearchParams(qs || ''));
  for (const [pattern, view, opts = {}] of ROUTES) {
    const keys = [];
    const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; })}/?$`);
    const m = re.exec(path);
    if (m) {
      const params = {};
      keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      return { path, view, opts, params, query };
    }
  }
  return { path, view: notFound, opts: {}, params: {}, query };
}

async function notFound(main) {
  mount(main, html`<div class="card empty"><span class="big-emoji">🦌</span><h2>This page wandered off</h2><p>Even Rudolph's nose can't find it.</p><a class="btn" href="#/">Back home</a></div>`);
}

export async function loadSession() {
  state.session = await api.get('/api/session');
  document.title = state.session.appTitle;
  document.getElementById('ver').textContent = `v${state.session.version}`;
  return state.session;
}

function themeIcon(theme) {
  return { auto: '🌗', light: '☀️', dark: '🌙' }[theme] || '🌗';
}

function currentTheme() {
  try { return localStorage.getItem('santa.theme') || 'auto'; } catch { return 'auto'; }
}

function setTheme(theme) {
  try { localStorage.setItem('santa.theme', theme); } catch { /* ignore */ }
  if (theme === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', theme);
}

function renderChrome(route) {
  const s = state.session;
  const u = s.user;
  const chrome = document.getElementById('chrome');
  const active = (prefix, exact = false) => {
    const p = route.path;
    return (exact ? p === prefix : p === prefix || p.startsWith(`${prefix}/`)) ? 'active' : '';
  };
  const showNav = u && !(u.mustChangePassword && !s.demo.enabled);
  mount(chrome, html`
    <header class="topbar">
      <div class="topbar-inner">
        ${showNav ? html`<button class="icon-btn nav-toggle" data-act="nav" aria-label="Menu">☰</button>` : ''}
        <a class="brand" href="#/">${hat}<span>${s.appTitle}</span></a>
        <nav class="nav" id="nav">
          ${showNav ? html`
            ${u.role === 'admin' ? html`
              <a href="#/admin" class="${active('/admin')}">🧝 Admin</a>
              <a href="#/guide" class="${active('/guide')}">📜 How to play</a>` : html`
              <a href="#/" class="${active('/', true) || active('/team') || active('/manage') || active('/join')}">🎄 My games</a>
              <a href="#/wishlist" class="${active('/wishlist')}">🎁 Wishlist</a>
              <a href="#/profile" class="${active('/profile')}">⭐ About me</a>
              <a href="#/guide" class="${active('/guide')}">📜 How to play</a>`}` : ''}
        </nav>
        <div class="top-actions">
          <button class="icon-btn" data-act="snow" title="Snow on/off" aria-label="Falling snow" aria-pressed="${document.querySelector('canvas.snow') ? 'true' : 'false'}">❄️</button>
          <button class="icon-btn" data-act="theme" title="Theme: ${currentTheme()}" aria-label="Change theme">${themeIcon(currentTheme())}</button>
          ${u ? html`
            <div class="menu" id="user-menu">
              <button class="user-chip" data-act="menu" aria-haspopup="true">${avatar(u.name)}<span class="uname">${u.name.split(' ')[0]}</span><span class="caret">▾</span></button>
              <div class="menu-panel" role="menu">
                <div class="who"><b>${u.name}</b><br><span class="muted">${u.email || u.username}</span></div>
                ${u.role === 'admin' ? '' : html`<a href="#/profile" role="menuitem">⭐ About me</a>`}
                ${u.hasPassword ? html`<a href="#/password" role="menuitem">🔑 Change password</a>` : ''}
                <button data-act="logout" role="menuitem">🚪 Sign out</button>
              </div>
            </div>` : ''}
        </div>
      </div>
    </header>
    ${s.demo.enabled ? html`<div class="demo-banner">🧪 <b>Demo mode</b> - made-up people and games. Every sign-in code is <code>${s.demo.otp}</code>; admin / admin works too. No email ever leaves the app.</div>` : ''}`);
}

let chromeBound = false;
function bindChrome() {
  if (chromeBound) return;
  chromeBound = true;
  const chrome = document.getElementById('chrome');
  actions(chrome, {
    nav: () => document.getElementById('nav').classList.toggle('open'),
    snow: (d, el, e) => {
      const on = !document.querySelector('canvas.snow');
      setSnow(on);
      saveSnow(on);
      e.target.closest('[data-act]').setAttribute('aria-pressed', on ? 'true' : 'false');
    },
    theme: () => {
      const order = ['auto', 'light', 'dark'];
      const next = order[(order.indexOf(currentTheme()) + 1) % order.length];
      setTheme(next);
      toast(`Theme: ${{ auto: 'follow my device', light: 'snowy day', dark: 'silent night' }[next]}`);
      render();
    },
    menu: () => document.getElementById('user-menu').classList.toggle('open'),
    logout: async () => {
      await api.post('/api/auth/logout');
      await loadSession();
      location.hash = '#/login';
    },
  });
  document.addEventListener('click', (e) => {
    const menu = document.getElementById('user-menu');
    if (menu && !menu.contains(e.target)) menu.classList.remove('open');
  });
}

let renderSeq = 0;
export async function render() {
  const seq = ++renderSeq;
  const route = parseHash();
  const s = state.session;
  const u = s.user;
  if (!u && !route.opts.public) {
    // come back here after signing in (an invite link, say)
    try { if (route.path !== '/') sessionStorage.setItem('santa.after', location.hash); } catch { /* ignore */ }
    location.replace('#/login');
    return;
  }
  if (u && route.path === '/login') {
    location.replace('#/');
    return;
  }
  if (u && u.mustChangePassword && !s.demo.enabled && !route.opts.allowPasswordChange && !route.opts.public) {
    location.replace('#/password');
    return;
  }
  // Two separate roles: an admin account runs the platform and has no games.
  if (route.opts.player && u.role === 'admin') {
    if (!['/', '/wishlist'].includes(route.path)) toast('Admin accounts run the platform, not games - sign in with your own player account to play or organise', 'error');
    location.replace('#/admin');
    return;
  }
  if (route.opts.admin && u.role !== 'admin') {
    location.replace('#/');
    return;
  }
  renderChrome(route);
  // A fresh <main> per page drops every listener the previous page attached.
  const old = document.getElementById('main');
  const main = old.cloneNode(false);
  old.replaceWith(main);
  loading(main);
  try {
    await route.view(main, { params: route.params, query: route.query, session: s, refresh: render, isCurrent: () => seq === renderSeq });
  } catch (err) {
    if (seq !== renderSeq) return;
    if (err.status === 401) return;
    mount(main, html`<div class="card empty"><span class="big-emoji">🌨️</span><h2>Something went sideways</h2><p>${err.message}</p><button class="btn" data-act="retry">Try again</button></div>`);
    actions(main, { retry: () => render() });
  }
  main.focus({ preventScroll: true });
}

async function boot() {
  try {
    await loadSession();
  } catch (err) {
    mount(document.getElementById('main'), html`<div class="card empty"><span class="big-emoji">🌨️</span><h2>Can't reach the workshop</h2><p>${err.message}</p></div>`);
    return;
  }
  bindChrome();
  setSnow(snowPreference());
  installSecrets();
  window.addEventListener('hashchange', () => {
    window.scrollTo(0, 0);
    render();
  });
  window.addEventListener('santa:signed-out', async () => {
    await loadSession().catch(() => {});
    if (!state.session.user) location.hash = '#/login';
  });
  render().catch(showError);
}

boot();
