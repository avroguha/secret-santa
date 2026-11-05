import { api, html, mount, actions, toast, formModal, confirmBox, extLink, formValues, errorText } from '../lib.js';
import { loadSession } from '../app.js';

const PRIORITIES = [[1, '🌟 Top wish'], [2, '🎁 Would love'], [3, '🍬 Nice to have']];

const wishForm = (w = {}) => html`
  <div class="field"><label for="w-title">What would you love?</label>
    <input id="w-title" name="title" required maxlength="160" value="${w.title || ''}" placeholder="Fuzzy reindeer socks"></div>
  <div class="field"><label for="w-url">Link <span class="muted">(optional)</span></label>
    <input id="w-url" name="url" type="url" maxlength="2000" value="${w.url || ''}" placeholder="https://shop.example/socks">
    <div class="hint">A shop page or a picture helps your Santa find exactly the right thing.</div></div>
  <div class="field"><label for="w-notes">Notes <span class="muted">(optional)</span></label>
    <textarea id="w-notes" name="notes" maxlength="1000" placeholder="Size M, any colour except orange">${w.notes || ''}</textarea></div>
  <div class="field"><label for="w-pri">How much do you want it?</label>
    <select id="w-pri" name="priority">${PRIORITIES.map(([n, l]) => html`<option value="${n}" ${(w.priority || 2) === n ? 'selected' : ''}>${l}</option>`)}</select></div>`;

export async function wishlistView(main, { isCurrent }) {
  let items = await api.get('/api/me/wishlist');
  if (!isCurrent()) return;
  const draw = () => mount(main, html`
    <div class="page-head">
      <div><h1>🎁 My wishlist</h1><p class="sub">Your Secret Santa sees this list in every game you play. Links are welcome!</p></div>
      <button class="btn red" data-act="add">+ Add a wish</button>
    </div>
    <div class="grid side">
      <div class="card">
        ${items.length ? html`<ul class="list">${items.map((w) => html`
          <li><span class="emoji">${PRIORITIES[w.priority - 1][1].split(' ')[0]}</span>
            <div class="grow"><div class="title">${w.title}</div>
              ${w.notes ? html`<div class="meta" style="white-space:pre-line">${w.notes}</div>` : ''}
              ${w.url ? html`<div class="meta">${extLink(w.url)}</div>` : ''}</div>
            <span class="badge ${w.priority === 1 ? 'red' : ''}">${PRIORITIES[w.priority - 1][1].replace(/^\S+ /, '')}</span>
            <div class="actions"><button class="btn link small" data-act="edit" data-id="${w.id}">Edit</button>
              <button class="btn danger-link small" data-act="del" data-id="${w.id}">Remove</button></div></li>`)}</ul>`
    : html`<div class="empty"><span class="big-emoji">📭</span><h3>Your wishlist is empty</h3><p>Help your Santa out - add a few things you'd love, from tiny treats to the dream final gift.</p>
          <button class="btn red" data-act="add">+ Add your first wish</button></div>`}
      </div>
      <aside class="card">
        <h3>💡 Wishlist tips</h3>
        <ul class="list">
          <li><span class="emoji">🍬</span><div class="grow">Mix small treats (for the surprises during the game) with one or two bigger ideas for the final gift.</div></li>
          <li><span class="emoji">📏</span><div class="grow">Put sizes, colours and allergies in your <a href="#/profile">hints</a>.</div></li>
          <li><span class="emoji">🔗</span><div class="grow">A link saves your Santa a lot of guessing.</div></li>
        </ul>
      </aside>
    </div>`);
  draw();
  actions(main, {
    add: async () => {
      const out = await formModal({ title: '🎁 Add a wish', submit: 'Add wish', body: wishForm(), onSubmit: (v) => api.post('/api/me/wishlist', v) });
      if (Array.isArray(out)) { items = out; draw(); toast('Added to your wishlist ✨', 'ok'); }
    },
    edit: async (d) => {
      const w = items.find((i) => String(i.id) === d.id);
      const out = await formModal({ title: 'Edit wish', body: wishForm(w), onSubmit: (v) => api.put(`/api/me/wishlist/${d.id}`, v) });
      if (Array.isArray(out)) { items = out; draw(); }
    },
    del: async (d) => {
      if (!await confirmBox('Remove this wish?', { ok: 'Remove', danger: true })) return;
      items = await api.del(`/api/me/wishlist/${d.id}`);
      draw();
    },
  });
}

const HINTS = [
  ['likes', '💚 Things I love', 'Hot cocoa, cosy socks, true-crime podcasts'],
  ['dislikes', '🚫 Not for me / allergies', 'Nothing with nuts, please'],
  ['hobbies', '🎨 Hobbies', 'Baking, board games, hiking'],
  ['colours', '🌈 Favourite colours', 'Forest green and gold'],
  ['sizes', '📏 Sizes', 'T-shirt M, shoes UK 6'],
];

export async function profileView(main, { isCurrent }) {
  const [me, locations] = await Promise.all([api.get('/api/me'), api.get('/api/locations')]);
  if (!isCurrent()) return;
  mount(main, html`
    <div class="page-head"><div><h1>⭐ About me</h1><p class="sub">Help your Secret Santa get it just right. Only your Santa sees your hints.</p></div></div>
    <form id="profile" class="grid side" novalidate>
      <div class="card">
        <h2>Hints for your Santa</h2>
        <div class="form-grid">
          ${HINTS.map(([k, label, ph]) => html`<div class="field"><label for="h-${k}">${label}</label><input id="h-${k}" name="${k}" maxlength="500" value="${me.hints[k]}" placeholder="${ph}"></div>`)}
          <div class="field full"><label for="h-note">📝 Anything else?</label><textarea id="h-note" name="note" maxlength="500" placeholder="I collect snow globes!">${me.hints.note}</textarea></div>
        </div>
        <div class="alert error" data-err hidden></div>
        <div class="form-actions"><button class="btn" type="submit">Save</button></div>
      </div>
      <aside class="stack">
        <div class="card">
          <h3>📍 Where I play from</h3>
          <div class="field"><label class="sr-only" for="loc">Location</label>
            <select id="loc" name="locationId"><option value="">Not set</option>
              ${locations.map((l) => html`<option value="${l.id}" ${me.locationId === l.id ? 'selected' : ''}>${l.name}</option>`)}</select>
            <div class="hint">You are matched with people in the same location. You can pick a different one per game on the game's page.</div></div>
          <div class="field"><label for="dn">Name to show <span class="muted">(optional)</span></label>
            <input id="dn" name="displayName" maxlength="120" value="${me.displayName || ''}" placeholder="${me.username}">
            <div class="hint">Leave empty to use ${me.username}.</div></div>
        </div>
        <div class="card">
          <h3>🔕 Do not disturb</h3>
          <label class="check"><input type="checkbox" id="dnd" ${me.dnd ? 'checked' : ''}>
            <span><b>Pause all Secret Santa emails</b><br><span class="muted">No reminders or notifications. You'll still see everything when you open the app, and a sign-in code still arrives whenever you ask for one.</span></span></label>
        </div>
        <div class="card tight">
          <p class="muted" style="margin:0">Signed in as <b>${me.username}</b><br>${me.email || ''}${me.externalId ? html`<br>ID ${me.externalId}` : ''}</p>
        </div>
      </aside>
    </form>`);
  const form = main.querySelector('#profile');
  const err = main.querySelector('[data-err]');
  // Saved at once, on its own - it is not part of the hints form.
  const dnd = main.querySelector('#dnd');
  dnd.addEventListener('change', async () => {
    try {
      await api.put('/api/me', { dnd: dnd.checked });
      toast(dnd.checked ? 'Shhh... no more emails 🤫 (the app still has everything)' : 'Emails are back on - jingle jingle! 🔔', 'ok');
    } catch (ex) {
      dnd.checked = !dnd.checked;
      toast(errorText(ex), 'error');
    }
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.hidden = true;
    const v = formValues(form);
    const hints = {};
    for (const k of ['likes', 'dislikes', 'hobbies', 'colours', 'sizes', 'note']) hints[k] = v[k] || '';
    try {
      await api.put('/api/me', { hints, locationId: v.locationId || null, displayName: v.displayName });
      await loadSession();
      toast('Saved - your Santa thanks you! 🎅', 'ok');
    } catch (ex) {
      err.textContent = errorText(ex);
      err.hidden = false;
    }
  });
}
