// Shared front-end helpers: safe HTML templating, the API client, dialogs,
// toasts and date formatting. Every value interpolated into html`` is
// escaped unless it is itself html`` (or raw()) output, so text typed by
// players can never become markup.

export class Raw {
  constructor(s) { this.s = s; }
  toString() { return this.s; }
}
export const raw = (s) => new Raw(String(s));

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

function renderValue(v) {
  if (v === null || v === undefined || v === false) return '';
  if (v instanceof Raw) return v.s;
  if (Array.isArray(v)) return v.map(renderValue).join('');
  return esc(String(v));
}

export function html(strings, ...vals) {
  let out = '';
  strings.forEach((s, i) => {
    out += s;
    if (i < vals.length) out += renderValue(vals[i]);
  });
  return new Raw(out);
}

export function mount(el, content) {
  el.innerHTML = String(content);
}

// ---- API -----------------------------------------------------------------------------
export class ApiError extends Error {
  constructor(message, status, details) {
    super(message);
    this.status = status;
    this.details = details || {};
  }
}

function cookie(name) {
  const m = document.cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return m ? decodeURIComponent(m[1]) : '';
}

async function request(method, url, body, retried = false) {
  const headers = { accept: 'application/json' };
  const csrf = cookie('ss_csrf');
  if (csrf) headers['x-csrf-token'] = csrf;
  if (body !== undefined) headers['content-type'] = 'application/json';
  let r;
  try {
    r = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin' });
  } catch {
    throw new ApiError('Could not reach the server - check your connection', 0);
  }
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text.slice(0, 200) }; }
  if (!r.ok) {
    const details = (data && data.details) || {};
    if (details.code === 'csrf' && !retried) {
      await fetch('/api/session', { credentials: 'same-origin' });
      return request(method, url, body, true);
    }
    if (r.status === 401 && details.code === 'signin') {
      window.dispatchEvent(new CustomEvent('santa:signed-out'));
    }
    if (details.code === 'password_change_required') location.hash = '#/password';
    throw new ApiError((data && data.error) || `Request failed (${r.status})`, r.status, details);
  }
  return data;
}

// For the email previews: the server's HTML, shown in a sandboxed srcdoc frame.
export async function fetchText(url) {
  const r = await fetch(url, { credentials: 'same-origin' });
  if (!r.ok) throw new ApiError(`Could not load the preview (${r.status})`, r.status);
  return r.text();
}

export function emailPreview(url, title = 'Email preview') {
  const m = openModal({ title, wide: true, body: html`<iframe sandbox title="${title}"></iframe>` });
  fetchText(url).then((text) => { const f = m.el.querySelector('iframe'); if (f) f.srcdoc = text; }).catch((err) => toast(err.message, 'error'));
  return m;
}

export const api = {
  get: (u) => request('GET', u),
  post: (u, b = {}) => request('POST', u, b),
  put: (u, b = {}) => request('PUT', u, b),
  del: (u) => request('DELETE', u),
};

// ---- toasts ------------------------------------------------------------------------------
export function toast(message, kind = '') {
  const box = document.getElementById('toasts');
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.textContent = message;
  box.appendChild(t);
  setTimeout(() => t.remove(), kind === 'error' ? 6500 : 3800);
}

export function errorText(err) {
  if (!err) return 'Something went wrong';
  const problems = err.details && err.details.problems;
  return problems && problems.length ? `${err.message}: ${problems.join(' ')}` : err.message;
}

export const showError = (err) => toast(errorText(err), 'error');

// ---- dialogs ---------------------------------------------------------------------------------
// openModal returns { el, close, done } where done resolves with the value
// passed to close() (or null when dismissed).
export function openModal({ title, body, foot = '', wide = false, onOpen }) {
  const d = document.createElement('dialog');
  d.className = `modal${wide ? ' wide' : ''}`;
  mount(d, html`
    <div class="modal-head"><h2>${title}</h2><button class="icon-btn plain" data-close aria-label="Close">✕</button></div>
    <div class="modal-body">${body}</div>
    ${foot ? html`<div class="modal-foot">${foot}</div>` : ''}`);
  document.body.appendChild(d);
  let resolve;
  const done = new Promise((r) => { resolve = r; });
  let result = null;
  const close = (value = null) => {
    result = value;
    d.close();
  };
  d.addEventListener('close', () => {
    d.remove();
    resolve(result);
  });
  d.addEventListener('click', (e) => {
    if (e.target === d) close();
    if (e.target.closest('[data-close]')) close();
  });
  d.showModal();
  if (onOpen) onOpen(d, close);
  const first = d.querySelector('[autofocus], .modal-body input, .modal-body textarea, .modal-body select');
  if (first) first.focus();
  return { el: d, close, done };
}

export function confirmBox(message, { title = 'Are you sure?', ok = 'Yes', danger = false, detail = '' } = {}) {
  const m = openModal({
    title,
    body: html`<p>${message}</p>${detail ? html`<p class="muted">${detail}</p>` : ''}`,
    foot: html`<button class="btn ghost" data-close>Cancel</button><button class="btn ${danger ? 'red' : ''}" data-ok>${ok}</button>`,
    onOpen: (d, close) => d.querySelector('[data-ok]').addEventListener('click', () => close(true)),
  });
  return m.done.then((v) => v === true);
}

// A modal holding a <form>. onSubmit(values) may throw an ApiError; the
// message is shown in the form and the modal stays open.
export function formModal({ title, body, submit = 'Save', danger = false, wide = false, onSubmit, onOpen }) {
  const m = openModal({
    title,
    wide,
    body: html`<form id="modal-form" novalidate>${body}<div class="alert error" data-err hidden></div></form>`,
    foot: html`<button class="btn ghost" data-close type="button">Cancel</button><button class="btn ${danger ? 'red' : ''}" type="submit" form="modal-form">${submit}</button>`,
    onOpen: (d, close) => {
      const form = d.querySelector('form');
      const errBox = d.querySelector('[data-err]');
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = d.querySelector('button[type=submit]');
        btn.disabled = true;
        errBox.hidden = true;
        try {
          const out = await onSubmit(formValues(form), form);
          close(out === undefined ? true : out);
        } catch (err) {
          errBox.textContent = errorText(err);
          errBox.hidden = false;
          btn.disabled = false;
        }
      });
      if (onOpen) onOpen(d, close);
    },
  });
  return m.done;
}

export function formValues(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name || el.disabled) continue;
    if (el.type === 'checkbox') out[el.name] = el.checked;
    else if (el.type === 'radio') { if (el.checked) out[el.name] = el.value; }
    else out[el.name] = el.value;
  }
  return out;
}

// ---- events ------------------------------------------------------------------------------------
// Delegated handlers keyed by data-act, e.g. <button data-act="delete" data-id="4">.
export function actions(root, handlers) {
  const listener = async (e) => {
    const el = e.target.closest('[data-act]');
    if (!el || !root.contains(el)) return;
    const fn = handlers[el.dataset.act];
    if (!fn) return;
    if (el.tagName === 'A' || el.tagName === 'BUTTON') e.preventDefault();
    if (el.dataset.busy) return;
    el.dataset.busy = '1';
    try {
      await fn(el.dataset, el, e);
    } catch (err) {
      showError(err);
    } finally {
      delete el.dataset.busy;
    }
  };
  root.addEventListener('click', listener);
  return () => root.removeEventListener('click', listener);
}

// ---- dates ------------------------------------------------------------------------------------
const dateOf = (d) => new Date(`${d}T00:00:00`);
export function fmtDate(d, opts = { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) {
  if (!d) return '';
  const dt = dateOf(d);
  return Number.isNaN(dt.getTime()) ? d : dt.toLocaleDateString(undefined, opts);
}
export const fmtShort = (d) => fmtDate(d, { day: 'numeric', month: 'short' });
export function fmtDateTime(iso) {
  if (!iso) return '';
  const dt = new Date(iso);
  return Number.isNaN(dt.getTime()) ? iso : dt.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
export function daysBetween(a, b) {
  return Math.round((dateOf(b) - dateOf(a)) / 86400000);
}
export function ago(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} d ago`;
  return fmtDateTime(iso);
}
export function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ---- bits of UI ------------------------------------------------------------------------------
export function avatar(name, { mystery = false, cls = '' } = {}) {
  if (mystery) return html`<span class="avatar mystery ${cls}" aria-hidden="true">🎅</span>`;
  const parts = (String(name || '').replace(/[^\p{L}\s]/gu, '').trim() || '?').split(/\s+/);
  const initials = (parts[0][0] || '?') + (parts.length > 1 ? parts[parts.length - 1][0] : '');
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return html`<span class="avatar c${(h % 6) + 1} ${cls}" aria-hidden="true">${initials}</span>`;
}

export const PHASES = {
  setup: { label: 'Getting ready', emoji: '📝' },
  drawn: { label: 'Names drawn', emoji: '🎟️' },
  live: { label: 'Game on!', emoji: '🎄' },
  ended: { label: 'All wrapped up', emoji: '🎁' },
};
export const phaseBadge = (phase) => html`<span class="badge phase-${phase}">${PHASES[phase].emoji} ${PHASES[phase].label}</span>`;

export function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

export function loading(el) {
  mount(el, html`<div class="loading"><div class="bauble"></div></div>`);
}

// A safe outbound link: http(s) only (the server also refuses anything else).
export function extLink(url, label) {
  if (!/^https?:\/\//i.test(url || '')) return html`${label || url}`;
  let host = url;
  try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { /* keep */ }
  return html`<a href="${url}" target="_blank" rel="noopener noreferrer nofollow">${label || host} ↗</a>`;
}

export const nl = (s) => html`${s}`;

// The organiser's guidelines: a small, safe Markdown subset. Everything is
// escaped first; only # headings, - and 1. lists, **bold**, *italic* and
// [text](https://...) links become markup.
export function markdown(src) {
  const inline = (s) => esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?![*\w])/g, '$1<i>$2</i>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (m, t, u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${t} ↗</a>`);
  let out = '';
  let list = null;
  let para = [];
  const flushPara = () => {
    if (para.length) out += `<p>${para.map(inline).join('<br>')}</p>`;
    para = [];
  };
  const flushList = () => {
    if (list) out += `<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`;
    list = null;
  };
  for (const line of String(src || '').replace(/\r\n?/g, '\n').split('\n')) {
    const t = line.trim();
    let m;
    if (!t) { flushPara(); flushList(); continue; }
    if ((m = /^(#{1,3})\s+(.*)$/.exec(t))) {
      flushPara(); flushList();
      const level = m[1].length + 1;
      out += `<h${level}>${inline(m[2])}</h${level}>`;
      continue;
    }
    if ((m = /^[-*•]\s+(.*)$/.exec(t)) || (m = /^\d+[.)]\s+(.*)$/.exec(t))) {
      const tag = /^\d/.test(t) ? 'ol' : 'ul';
      flushPara();
      if (!list || list.tag !== tag) { flushList(); list = { tag, items: [] }; }
      list.items.push(m[1]);
      continue;
    }
    flushList();
    para.push(t);
  }
  flushPara();
  flushList();
  return raw(`<div class="prose">${out}</div>`);
}

// ---- secret names ---------------------------------------------------------------------
// A Santa's child is shown like a password: a row of dots and a "hold to peek"
// button. The name appears only while the button is held down (mouse, finger,
// or Space / Enter) and goes away the moment it is released, the pointer is
// cancelled, the button loses focus, or the window is hidden. The name itself
// is never in the page while hidden - it lives in this map, keyed by a random
// id - so find-in-page, text selection, copy and screen-reader browsing cannot
// reach it either. The mask has a fixed length so it does not hint at the name.
const SECRETS = new Map();
const MASK = '<span aria-hidden="true">••••••••</span><span class="sr-only">hidden name</span>';

export function secretName(name, { hint = 'Hold to peek' } = {}) {
  if (SECRETS.size > 200) {
    for (const key of SECRETS.keys()) if (!document.querySelector(`[data-secret="${key}"]`)) SECRETS.delete(key);
  }
  const key = `s${Math.random().toString(36).slice(2, 10)}`;
  SECRETS.set(key, String(name));
  return html`<span class="secret" data-secret="${key}"><span class="secret-text" aria-live="polite">${raw(MASK)}</span><button type="button" class="secret-peek" aria-label="Press and hold to see the name"><span aria-hidden="true">👁️</span> ${hint}</button></span>`;
}

function showSecret(btn) {
  const box = btn.closest('[data-secret]');
  const name = box && SECRETS.get(box.dataset.secret);
  if (name === undefined || name === null) return;
  box.classList.add('shown');
  box.querySelector('.secret-text').textContent = name;
}

export function hideSecrets() {
  document.querySelectorAll('.secret.shown').forEach((box) => {
    box.classList.remove('shown');
    box.querySelector('.secret-text').innerHTML = MASK;
  });
}

let secretsInstalled = false;
export function installSecrets() {
  if (secretsInstalled) return;
  secretsInstalled = true;
  const peek = (e) => (e.target instanceof Element ? e.target.closest('.secret-peek') : null);
  document.addEventListener('pointerdown', (e) => {
    const btn = peek(e);
    if (!btn || e.button > 0) return;
    e.preventDefault(); // no focus jump, no text selection, no long-press menu
    try { btn.setPointerCapture(e.pointerId); } catch { /* not every pointer can be captured */ }
    showSecret(btn);
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) document.addEventListener(type, hideSecrets, true);
  document.addEventListener('keydown', (e) => {
    const btn = peek(e);
    if (!btn || (e.key !== ' ' && e.key !== 'Enter')) return;
    e.preventDefault();
    if (!e.repeat) showSecret(btn);
  });
  document.addEventListener('keyup', (e) => { if (peek(e) && (e.key === ' ' || e.key === 'Enter')) hideSecrets(); });
  document.addEventListener('focusout', (e) => { if (peek(e)) hideSecrets(); });
  // A held button must never trigger anything else (a card link, a delegated action).
  document.addEventListener('click', (e) => { if (peek(e)) { e.preventDefault(); e.stopPropagation(); } }, true);
  document.addEventListener('contextmenu', (e) => { if (peek(e)) e.preventDefault(); }, true);
  window.addEventListener('blur', hideSecrets);
  window.addEventListener('pagehide', hideSecrets);
  document.addEventListener('visibilitychange', () => { if (document.hidden) hideSecrets(); });
}
