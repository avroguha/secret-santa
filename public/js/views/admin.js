import {
  api, html, mount, actions, toast, formModal, confirmBox, emailPreview, fmtShort, fmtDateTime, ago, phaseBadge,
  plural, formValues, errorText, avatar, markdown,
} from '../lib.js';

export const ADMIN_TABS = [
  ['/admin', '📊 Overview'], ['/admin/users', '👥 People'], ['/admin/import', '📥 Import CSV'], ['/admin/locations', '📍 Locations'],
  ['/admin/games', '🎄 Games'], ['/admin/guidelines', '📜 Guidelines'], ['/admin/email', '✉️ Email'], ['/admin/signin', '🔐 Sign-in'], ['/admin/outbox', '📮 Outbox'], ['/admin/audit', '📜 Audit log'],
];

export function adminNav(current) {
  return html`<nav class="tabs">${ADMIN_TABS.map(([p, l]) => html`<a href="#${p}" class="${current === p ? 'active' : ''}">${l}</a>`)}</nav>`;
}

// ---- overview ---------------------------------------------------------------------------
export async function overviewView(main, { isCurrent, session }) {
  const o = await api.get('/api/admin/overview');
  if (!isCurrent()) return;
  const c = o.counts;
  mount(main, html`
    <div class="page-head"><div><h1>🧝 Elf headquarters</h1><p class="sub">The platform: people, sign-in, email and the games everyone runs. Each game belongs to its organiser.</p></div></div>
    ${adminNav('/admin')}
    ${o.warnings.length ? html`<div class="stack" style="margin-bottom:18px">${o.warnings.map((w) => html`
      <div class="alert ${w.level === 'error' ? 'error' : w.level === 'info' ? 'info' : 'warn'}"><span class="ico">${w.level === 'error' ? '⛔' : w.level === 'info' ? 'ℹ️' : '⚠️'}</span>
        <div class="grow">${w.text} ${w.link ? html`<a href="${w.link}">Fix it →</a>` : ''}</div></div>`)}</div>`
    : html`<div class="alert ok"><span class="ico">✅</span><div>All is calm, all is bright - nothing needs your attention.</div></div>`}
    <div class="stat-row">
      <div class="stat"><div class="n">${c.users}</div><div class="l">people</div></div>
      <div class="stat"><div class="n">${c.teams}</div><div class="l">games</div></div>
      <div class="stat"><div class="n">${c.locations}</div><div class="l">locations</div></div>
      <div class="stat"><div class="n">${c.wishes}</div><div class="l">wishes</div></div>
      <div class="stat"><div class="n">${c.gifts}</div><div class="l">gifts logged</div></div>
      <div class="stat"><div class="n">${c.tasksDone}/${c.tasks}</div><div class="l">tasks done</div></div>
      <div class="stat"><div class="n">${c.queued}</div><div class="l">emails queued</div></div>
    </div>
    <div class="section-title"><h2>🎄 Games</h2><a href="#/admin/games">All games →</a></div>
    ${o.teams.length ? html`<div class="table-wrap"><table class="table table-cards">
      <thead><tr><th>Game</th><th>Organiser</th><th>Status</th><th>Dates</th><th class="num">Players</th></tr></thead>
      <tbody>${o.teams.slice(0, 8).map((t) => html`<tr>
        <td class="first"><b>${t.name}</b></td>
        <td data-label="Organiser">${t.owner ? t.owner.name : html`<span class="badge warn">nobody</span>`}</td>
        <td data-label="Status">${phaseBadge(t.phase)}</td>
        <td data-label="Dates" class="nowrap">${fmtShort(t.startDate)} - ${fmtShort(t.endDate)}</td>
        <td data-label="Players" class="num">${t.memberCount}</td></tr>`)}</tbody></table></div>`
    : html`<div class="card empty"><span class="big-emoji">🎄</span>No games yet. Anyone can create one from their home page.</div>`}
    ${session.demo.enabled ? html`
      <div class="card" style="margin-top:22px">
        <h3>🧪 Demo data</h3>
        <p class="muted">This is the demo database. Reset it to put every made-up person, game, gift and task back the way it started (dates move to today). Your mail relay settings are kept.</p>
        <button class="btn ghost" data-act="reset-demo">♻️ Reset the demo</button>
      </div>` : ''}`);
  actions(main, {
    'reset-demo': async () => {
      if (!await confirmBox('Reset all demo data? You will be signed out.', { ok: 'Reset', danger: true })) return;
      await api.post('/api/admin/demo/reset');
      location.hash = '#/login';
      location.reload();
    },
  });
}

// ---- people ---------------------------------------------------------------------------------
const userForm = (u, locations) => html`
  <div class="form-grid">
    <div class="field"><label for="u-name">Name (userName)</label><input id="u-name" name="username" required maxlength="120" value="${u.username || ''}"></div>
    <div class="field"><label for="u-id">ID</label><input id="u-id" name="externalId" maxlength="64" value="${u.externalId || ''}"></div>
    <div class="field full"><label for="u-email">Email</label><input id="u-email" name="email" type="email" value="${u.email || ''}"></div>
    <div class="field"><label for="u-dn">Display name <span class="muted">(optional)</span></label><input id="u-dn" name="displayName" maxlength="120" value="${u.displayName || ''}"></div>
    <div class="field"><label for="u-loc">Location</label><select id="u-loc" name="locationId"><option value="">Not set</option>
      ${locations.map((l) => html`<option value="${l.id}" ${u.locationId === l.id ? 'selected' : ''}>${l.name}</option>`)}</select></div>
    <div class="field"><label for="u-role">Role</label><select id="u-role" name="role">
      <option value="user" ${u.role !== 'admin' ? 'selected' : ''}>Player</option><option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Admin</option></select></div>
    <div class="field"><label>&nbsp;</label><label class="check"><input type="checkbox" name="active" ${u.active !== false ? 'checked' : ''}> Active (can sign in)</label></div>
  </div>`;

export async function usersView(main, { isCurrent, query, session }) {
  let q = query.q || '';
  const locations = await api.get('/api/locations');
  let users = await api.get(`/api/admin/users?q=${encodeURIComponent(q)}`);
  if (!isCurrent()) return;
  const draw = () => {
    mount(main, html`
      <div class="page-head"><div><h1>👥 People</h1><p class="sub">${plural(users.length, 'person', 'people')}${q ? ` matching "${q}"` : ''}</p></div>
        <div class="row"><a class="btn ghost" href="/api/admin/users/export.csv" download>⬇️ Export CSV</a><a class="btn ghost" href="#/admin/import">📥 Import CSV</a><button class="btn red" data-act="add">+ Add a person</button></div></div>
      ${adminNav('/admin/users')}
      <form id="search" class="inline-form" style="margin-bottom:14px"><div class="field"><label class="sr-only" for="q">Search</label>
        <input id="q" name="q" type="search" value="${q}" placeholder="Search by name, email, ID or location"></div><button class="btn ghost" type="submit">Search</button></form>
      <div class="table-wrap"><table class="table table-cards">
        <thead><tr><th>Name</th><th>ID</th><th>Email</th><th>Location</th><th>Last sign-in</th><th></th></tr></thead>
        <tbody>${users.map((u) => html`<tr>
          <td class="first"><div class="row" style="flex-wrap:nowrap">${avatar(u.name, { cls: 'tiny' })}<b>${u.name}</b>
            ${u.role === 'admin' ? html`<span class="badge gold">admin</span>` : ''} ${!u.active ? html`<span class="badge">inactive</span>` : ''} ${u.dnd ? html`<span class="badge" title="Do not disturb - no emails">🔕</span>` : ''}</div>
            ${u.displayName ? html`<div class="muted" style="font-size:.8rem">${u.username}</div>` : ''}</td>
          <td data-label="ID">${u.externalId || ''}</td><td data-label="Email">${u.email || html`<span class="muted">-</span>`}</td>
          <td data-label="Location">${u.locationName || html`<span class="badge warn">not set</span>`}</td>
          <td data-label="Last sign-in" class="nowrap">${u.lastLoginAt ? ago(u.lastLoginAt) : html`<span class="muted">never</span>`}</td>
          <td class="nowrap"><button class="btn link small" data-act="edit" data-id="${u.id}">Edit</button>
            ${u.id !== session.user.id ? html`<button class="btn danger-link small" data-act="del" data-id="${u.id}">Delete</button>` : ''}</td></tr>`)}</tbody>
      </table></div>
      ${!users.length ? html`<div class="card empty" style="margin-top:12px"><span class="big-emoji">🧑‍🎄</span>Nobody here yet - <a href="#/admin/import">import a CSV</a>.</div>` : ''}`);
    main.querySelector('#search').addEventListener('submit', async (e) => {
      e.preventDefault();
      q = formValues(e.target).q.trim();
      users = await api.get(`/api/admin/users?q=${encodeURIComponent(q)}`);
      draw();
    });
  };
  draw();
  const reload = async () => { users = await api.get(`/api/admin/users?q=${encodeURIComponent(q)}`); draw(); };
  actions(main, {
    add: async () => {
      const ok = await formModal({ title: '🧑‍🎄 Add a person', submit: 'Add', wide: true, body: userForm({}, locations), onSubmit: (v) => api.post('/api/admin/users', v) });
      if (ok) { toast('Added 🎉', 'ok'); reload(); }
    },
    edit: async (d) => {
      const u = users.find((x) => String(x.id) === d.id);
      const ok = await formModal({
        title: `Edit ${u.name}`,
        wide: true,
        body: html`${userForm(u, locations)}
          <fieldset><legend>🔑 Password sign-in</legend>
            <p class="muted">${u.hasPassword ? 'This account can sign in with a password.' : 'This account signs in with an email code or Microsoft. Give it a password only if it needs one (for example a second admin).'}</p>
            <div class="inline-form"><div class="field"><label for="u-pw">New password</label><input id="u-pw" type="password" autocomplete="new-password" minlength="8"></div>
              <button class="btn ghost small" type="button" data-pw="${u.id}">Set password</button>
              ${u.hasPassword && u.id !== session.user.id ? html`<button class="btn danger-link small" type="button" data-pw-clear="${u.id}">Remove password</button>` : ''}</div>
          </fieldset>`,
        onSubmit: (v) => api.put(`/api/admin/users/${d.id}`, v),
        onOpen: (dlg) => {
          dlg.addEventListener('click', async (e) => {
            const set = e.target.closest('[data-pw]');
            const clear = e.target.closest('[data-pw-clear]');
            try {
              if (set) {
                await api.post(`/api/admin/users/${u.id}/password`, { password: dlg.querySelector('#u-pw').value });
                toast('Password set - they will be asked to change it at the next sign-in', 'ok');
              }
              if (clear) {
                await api.post(`/api/admin/users/${u.id}/password`, { password: '' });
                toast('Password removed', 'ok');
              }
            } catch (err) { toast(errorText(err), 'error'); }
          });
        },
      });
      if (ok) { toast('Saved', 'ok'); reload(); }
    },
    del: async (d) => {
      const u = users.find((x) => String(x.id) === d.id);
      if (!await confirmBox(`Delete ${u.name}?`, { ok: 'Delete', danger: true, detail: 'They are taken out of every team. In a team that has drawn names, their Santa takes over their child so the circle stays whole.' })) return;
      await api.del(`/api/admin/users/${d.id}`);
      toast(`${u.name} deleted`);
      reload();
    },
  });
}

// ---- CSV import -------------------------------------------------------------------------------------
export async function importView(main, { isCurrent }) {
  if (!isCurrent()) return;
  let csv = '';
  let fileName = '';
  let plan = null;
  const SAMPLE = 'userName,ID,email,location\nHolly Berry,E1001,holly.berry@example.com,North Pole\nJack Frost,E1002,jack.frost@example.com,North Pole\nCarol Singer,E1003,carol.singer@example.com,Gingerbread Town\n';
  const draw = () => {
    mount(main, html`
      <div class="page-head"><div><h1>📥 Import people from CSV</h1><p class="sub">Columns <b>userName</b>, <b>ID</b> and <b>email</b> are required; <b>location</b> is optional. Organisers add people to their own games.</p></div></div>
      ${adminNav('/admin/import')}
      <div class="grid side">
        <div class="stack">
          <div class="card">
            <h3>1. Choose the file</h3>
            <div class="field"><input type="file" id="file" accept=".csv,text/csv,text/plain"><div class="hint">${fileName ? html`Loaded <b>${fileName}</b>.` : 'Comma, semicolon or tab separated; the first row is the header. People already here (same ID or email) are updated, not duplicated.'}</div></div>
            <div class="form-grid">
              <div class="field full"><label class="check"><input type="checkbox" id="mkloc" checked> Create locations that don't exist yet</label></div>
            </div>
            <div class="row"><button class="btn" data-act="preview" ${csv ? '' : 'disabled'}>🔍 Check the file</button>
              ${plan && plan.summary.create + plan.summary.update > 0 ? html`<button class="btn red" data-act="commit">✅ Import ${plural(plan.summary.create + plan.summary.update, 'person', 'people')}</button>` : ''}</div>
          </div>
          ${plan ? html`
            <div class="card">
              <h3>2. Check what will happen</h3>
              <div class="row" style="margin-bottom:10px">
                <span class="badge ok">${plan.summary.create} new</span><span class="badge blue">${plan.summary.update} updated</span>
                <span class="badge">${plan.summary.unchanged} unchanged</span><span class="badge ${plan.summary.error ? 'error' : ''}">${plan.summary.error} with errors (skipped)</span>
                ${plan.newLocations.length ? html`<span class="badge gold">new locations: ${plan.newLocations.join(', ')}</span>` : ''}
              </div>
              <p class="muted">Columns found: ${Object.entries(plan.columns).map(([k, v]) => `${k} ← "${v}"`).join(' · ')}</p>
              <div class="table-wrap" style="max-height:440px;overflow:auto"><table class="table">
                <thead><tr><th>Line</th><th>What</th><th>userName</th><th>ID</th><th>email</th><th>location</th><th>Notes</th></tr></thead>
                <tbody>${plan.rows.map((r) => html`<tr class="${r.action === 'error' ? 'row-error' : r.warnings.length ? 'row-warn' : ''}">
                  <td>${r.line}</td><td>${{ create: html`<span class="badge ok">new</span>`, update: html`<span class="badge blue">update</span>`, unchanged: html`<span class="badge">same</span>`, error: html`<span class="badge error">error</span>` }[r.action]}</td>
                  <td>${r.username}</td><td>${r.externalId}</td><td>${r.email}</td><td>${r.location}</td>
                  <td>${r.errors.concat(r.warnings).join('; ')}</td></tr>`)}</tbody></table></div>
            </div>` : ''}
        </div>
        <aside class="card">
          <h3>📄 Example</h3>
          <pre style="white-space:pre-wrap;font:.85rem/1.5 var(--mono);background:var(--surface-2);padding:10px;border-radius:10px;margin:0 0 10px">${SAMPLE}</pre>
          <button class="btn ghost small" data-act="sample">⬇️ Download this template</button>
          <hr>
          <p class="muted">Header names are flexible: <i>Employee ID</i>, <i>Email Address</i>, <i>Office</i> and similar work too.</p>
        </aside>
      </div>`);
    main.querySelector('#file').addEventListener('change', async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      if (f.size > 8 * 1024 * 1024) { toast('That file is over 8 MB', 'error'); return; }
      csv = await f.text();
      fileName = f.name;
      plan = null;
      draw();
      main.querySelector('[data-act=preview]').click();
    });
  };
  draw();
  const opts = () => ({ csv, createLocations: main.querySelector('#mkloc').checked });
  actions(main, {
    preview: async () => {
      const keep = opts();
      plan = await api.post('/api/admin/users/import', keep);
      draw();
      main.querySelector('#mkloc').checked = keep.createLocations;
    },
    commit: async () => {
      const r = await api.post('/api/admin/users/import', { ...opts(), commit: true });
      toast(`Imported: ${r.summary.create} new, ${r.summary.update} updated 🎉`, 'ok');
      location.hash = '#/admin/users';
    },
    sample: () => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([SAMPLE], { type: 'text/csv' }));
      a.download = 'secret-santa-template.csv';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    },
  });
}

// ---- locations --------------------------------------------------------------------------------
export async function locationsView(main, { isCurrent }) {
  let locs = await api.get('/api/admin/locations');
  if (!isCurrent()) return;
  const draw = () => {
    mount(main, html`
      <div class="page-head"><div><h1>📍 Locations</h1><p class="sub">Where people play from. Names are drawn within a location unless a team matches everyone together.</p></div></div>
      ${adminNav('/admin/locations')}
      <div class="grid side">
        <div class="card flush"><div class="table-wrap" style="border:0"><table class="table">
          <thead><tr><th>Location</th><th class="num">People</th><th></th></tr></thead>
          <tbody>${locs.map((l) => html`<tr><td><b>${l.name}</b></td><td class="num">${l.people}</td>
            <td class="num nowrap"><button class="btn link small" data-act="rename" data-id="${l.id}">Rename</button>
            <button class="btn danger-link small" data-act="del" data-id="${l.id}">Delete</button></td></tr>`)}</tbody></table></div>
          ${!locs.length ? html`<div class="empty">No locations yet.</div>` : ''}</div>
        <aside class="card">
          <h3>+ Add a location</h3>
          <form id="add" class="inline-form"><div class="field"><label class="sr-only" for="ln">Name</label><input id="ln" name="name" maxlength="80" placeholder="e.g. North Pole" required></div><button class="btn" type="submit">Add</button></form>
          <p class="muted" style="margin-top:12px">Locations in a CSV import are created automatically.</p>
        </aside>
      </div>`);
    main.querySelector('#add').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api.post('/api/admin/locations', formValues(e.target));
        locs = await api.get('/api/admin/locations');
        draw();
        toast('Location added 📍', 'ok');
      } catch (err) { toast(errorText(err), 'error'); }
    });
  };
  draw();
  actions(main, {
    rename: async (d) => {
      const l = locs.find((x) => String(x.id) === d.id);
      const ok = await formModal({ title: `Rename ${l.name}`, body: html`<div class="field"><label for="nn">New name</label><input id="nn" name="name" value="${l.name}" maxlength="80" required></div>`, onSubmit: (v) => api.put(`/api/admin/locations/${d.id}`, v) });
      if (ok) { locs = await api.get('/api/admin/locations'); draw(); }
    },
    del: async (d) => {
      const l = locs.find((x) => String(x.id) === d.id);
      if (!await confirmBox(`Delete ${l.name}?`, { ok: 'Delete', danger: true, detail: `${plural(l.people, 'person', 'people')} will have no location.` })) return;
      await api.del(`/api/admin/locations/${d.id}`);
      locs = await api.get('/api/admin/locations');
      draw();
    },
  });
}

// ---- email relay -----------------------------------------------------------------------------------
const PREVIEWS = [['otp', '🔑 Sign-in code'], ['locationReminder', '🌍 Check-in nudge'], ['matched', '🎅 Names drawn'], ['start', '🎄 Game starts'], ['taskAssigned', '🧝 New task'], ['giftLogged', '🎁 Gift logged'], ['message', '💌 Santa note'], ['giftReminder', '🔔 Gift jingle'], ['reminder', '✨ Wishlist nudge'], ['reveal', '🎉 Reveal'], ['test', '🔔 Test']];
const NOTIFY = [['locationReminder', 'Gentle check-in reminders before check-in closes (phase 1)'], ['giftReminder', 'A friendly gift jingle before the game ends (phase 2)'], ['matched', 'Names drawn - each Santa hears they are matched (the name stays in the app)'], ['start', 'The game starts today'], ['taskAssigned', 'A child gets a new fun task'], ['giftLogged', 'A child is told a gift is coming'], ['messages', 'Santa notes (both ways)'], ['reveal', 'The big reveal after the game']];

export async function emailView(main, { isCurrent }) {
  const s = await api.get('/api/admin/settings');
  if (!isCurrent()) return;
  const e = s.email;
  mount(main, html`
    <div class="page-head"><div><h1>✉️ Email</h1><p class="sub">An open SMTP relay: no username or password is ever stored.</p></div></div>
    ${adminNav('/admin/email')}
    ${s.demo ? html`<div class="alert gold"><span class="ico">🧪</span><div>Demo mode: game emails are kept in the <a href="#/admin/outbox">outbox</a> and never sent, sealed like real ones - the previews below show what each looks like. "Send a test email" below does send for real, so you can try the relay.</div></div>` : ''}
    <div class="grid two">
      <form id="relay" class="card" novalidate>
        <h2>📮 Mail relay</h2>
        <div class="form-grid">
          <div class="field"><label for="host">Relay host</label><input id="host" name="host" value="${e.host}" placeholder="smtp-relay.example.com"></div>
          <div class="field"><label for="port">Port</label><input id="port" name="port" type="number" min="1" max="65535" value="${e.port}"></div>
          <div class="field"><label for="sec">Security</label><select id="sec" name="security">
            ${[['none', 'None (plain SMTP, usually port 25)'], ['starttls', 'STARTTLS (usually port 587 or 25)'], ['tls', 'TLS from the start (usually port 465)']].map(([v, l]) => html`<option value="${v}" ${e.security === v ? 'selected' : ''}>${l}</option>`)}</select></div>
          <div class="field"><label>&nbsp;</label><label class="check"><input type="checkbox" name="allowInvalidCert" ${e.allowInvalidCert ? 'checked' : ''}> Accept a self-signed relay certificate</label></div>
          <div class="field"><label for="fn">From name</label><input id="fn" name="fromName" value="${e.fromName}" maxlength="80"></div>
          <div class="field"><label for="fe">From address</label><input id="fe" name="fromEmail" type="email" value="${e.fromEmail}" placeholder="secret-santa@example.com"></div>
          <div class="field full"><label for="rt">Reply-To <span class="muted">(optional)</span></label><input id="rt" name="replyTo" type="email" value="${e.replyTo}" placeholder="the organiser's address"></div>
        </div>
        <div class="alert error" data-err hidden></div>
        <div class="form-actions"><button class="btn" type="submit">Save relay</button></div>
        <hr>
        <h3>🔔 Send a test email</h3>
        <div class="inline-form"><div class="field"><label class="sr-only" for="to">Send to</label><input id="to" type="email" placeholder="you@example.com"></div><button class="btn gold" type="button" data-act="test">Send test</button></div>
        <p class="muted" data-test-result style="margin-top:8px"></p>
      </form>
      <div class="stack">
        <form id="general" class="card" novalidate>
          <h2>🌐 Links and name</h2>
          <div class="field"><label for="at">App name</label><input id="at" name="appTitle" value="${s.general.appTitle}" maxlength="60"></div>
          <div class="field"><label for="bu">Public address</label><input id="bu" name="baseUrl" value="${s.general.baseUrl}" placeholder="${s.envBaseUrl || 'https://santa.example.com'}">
            <div class="hint">Where links in emails point. Empty uses SANTA_BASE_URL from the env file${s.envBaseUrl ? ` (${s.envBaseUrl})` : ' (not set)'}. In use now: <b>${s.effectiveBaseUrl || 'nothing - links will be broken'}</b></div></div>
          <div class="form-actions"><button class="btn" type="submit">Save</button></div>
        </form>
        <form id="notify" class="card" novalidate>
          <h2>📣 Which emails go out</h2>
          ${NOTIFY.map(([k, l]) => html`<label class="check" style="margin-bottom:8px"><input type="checkbox" name="${k}" ${s.notifications[k] ? 'checked' : ''}> ${l}</label>`)}
          <p class="muted">Sign-in codes are always sent. Anyone on <b>Do not disturb</b> gets nothing else. Reminder days are set per team.</p>
          <div class="form-actions"><button class="btn" type="submit">Save</button></div>
        </form>
      </div>
    </div>
    <div class="card" style="margin-top:18px">
      <h2>👀 What the emails look like</h2>
      <div class="row">${PREVIEWS.map(([k, l]) => html`<button class="btn ghost small" data-act="preview" data-k="${k}">${l}</button>`)}</div>
    </div>`);
  const relay = main.querySelector('#relay');
  relay.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const err = relay.querySelector('[data-err]');
    err.hidden = true;
    try {
      await api.put('/api/admin/settings/email', formValues(relay));
      toast('Relay saved ✉️', 'ok');
    } catch (ex) { err.textContent = errorText(ex); err.hidden = false; }
  });
  main.querySelector('#general').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try { await api.put('/api/admin/settings/general', formValues(ev.target)); toast('Saved', 'ok'); } catch (ex) { toast(errorText(ex), 'error'); }
  });
  main.querySelector('#notify').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try { await api.put('/api/admin/settings/notifications', formValues(ev.target)); toast('Saved', 'ok'); } catch (ex) { toast(errorText(ex), 'error'); }
  });
  actions(main, {
    test: async () => {
      const out = main.querySelector('[data-test-result]');
      out.textContent = 'Sending… (save the relay first if you changed it)';
      const r = await api.post('/api/admin/settings/email/test', { to: main.querySelector('#to').value });
      out.textContent = `${r.ok ? '✅' : '⛔'} ${r.message}`;
    },
    preview: (d) => { emailPreview(`/api/admin/email-preview/${d.k}`); },
  });
}

// ---- sign-in -----------------------------------------------------------------------------------
export async function signinView(main, { isCurrent }) {
  let s = await api.get('/api/admin/settings');
  if (!isCurrent()) return;
  const draw = () => {
    const a = s.azure;
    const m = s.saml;
    mount(main, html`
      <div class="page-head"><div><h1>🔐 Sign-in</h1><p class="sub">Single sign-on (SAML or OpenID Connect), email codes and sign-up. The admin password always works.</p></div></div>
      ${adminNav('/admin/signin')}
      <div class="card" style="margin-bottom:var(--gap)">
        <div class="card-title"><h2>🪪 SAML single sign-on</h2><span class="badge blue">recommended for Microsoft Entra ID</span><span class="spacer"></span>
          ${m.configured ? (m.enabled ? html`<span class="badge ok">✓ on</span>` : html`<span class="badge">configured, switched off</span>`) : html`<span class="badge gold">not set up</span>`}</div>
        <div class="grid two">
          <div>
            <h3>1. Give these to the identity provider</h3>
            <p class="muted">In Entra ID: <b>Enterprise applications › New application › Create your own</b>, then <b>Single sign-on › SAML</b>. Or upload our metadata file there.</p>
            <div class="field"><label>Identifier (Entity ID)</label><div class="invite-box"><input readonly value="${m.sp.entityId}"><button class="btn ghost small" type="button" data-act="copy" data-v="${m.sp.entityId}">📋</button></div></div>
            <div class="field"><label>Reply URL (Assertion Consumer Service URL)</label><div class="invite-box"><input readonly value="${m.sp.acsUrl}"><button class="btn ghost small" type="button" data-act="copy" data-v="${m.sp.acsUrl}">📋</button></div></div>
            <a class="btn ghost small" href="/saml/metadata" download="secret-santa-sp-metadata.xml">⬇️ Our metadata (XML)</a>
            <p class="muted" style="margin-top:12px">Users must have an email claim (Entra sends <code>emailaddress</code> by default). People are matched to accounts by email.</p>
          </div>
          <div>
            <h3>2. Upload the identity provider's metadata</h3>
            <p class="muted">In Entra ID: <b>SAML Certificates › Federation Metadata XML › Download</b>. Everything is configured from it - sign-in address, issuer and signing certificate.</p>
            <div class="field"><label for="md-file">Metadata file (.xml)</label><input type="file" id="md-file" accept=".xml,application/xml,text/xml"></div>
            <details><summary class="muted" style="cursor:pointer">…or paste it, or give its URL</summary>
              <div class="field" style="margin-top:10px"><label for="md-xml">Paste the XML</label><textarea id="md-xml" style="min-height:110px;font-family:var(--mono);font-size:.82rem" placeholder="&lt;EntityDescriptor ..."></textarea></div>
              <div class="field"><label for="md-url">App Federation Metadata URL</label><input id="md-url" type="url" placeholder="https://login.microsoftonline.com/.../federationmetadata.xml?appid=..." value="${m.metadataUrl}">
                <div class="hint">With a URL the certificate is re-read every day, so a certificate rollover needs nothing from you. Behind a proxy set RUNTIME_HTTPS_PROXY.</div></div>
              <button class="btn ghost small" type="button" data-act="md-text">Configure from these</button>
            </details>
            <div class="alert error" data-md-err hidden style="margin-top:12px"></div>
          </div>
        </div>
        ${m.ssoUrl ? html`
          <hr>
          <h3>Current configuration</h3>
          <div class="hints">
            <div class="hint-box"><div class="k">Identity provider</div><div class="v" style="font-size:.86rem">${m.idpEntityId}</div></div>
            <div class="hint-box"><div class="k">Sign-in address</div><div class="v" style="font-size:.86rem">${m.ssoUrl}</div></div>
            ${m.certs.map((c) => html`<div class="hint-box"><div class="k">Signing certificate</div><div class="v" style="font-size:.86rem">${c.subject}<br>valid until ${fmtShort((c.validTo || '').slice(0, 10))}</div></div>`)}
          </div>
          <form id="saml" class="form-grid" style="margin-top:14px" novalidate>
            <div class="field"><label for="s-label">Button text</label><input id="s-label" name="buttonLabel" maxlength="60" value="${m.buttonLabel}"></div>
            <div class="field"><label for="s-email">Email claim <span class="muted">(optional)</span></label><input id="s-email" name="emailAttribute" value="${m.emailAttribute}" placeholder="the standard emailaddress claim">
              <div class="hint">Only if your identity provider sends the email under another name.</div></div>
            <div class="field full"><label class="check"><input type="checkbox" name="enabled" ${m.enabled ? 'checked' : ''}><span><b>Show the SAML sign-in button</b></span></label></div>
            <div class="form-actions full"><button class="btn danger-link" type="button" data-act="saml-remove">Remove SAML configuration</button><span class="spacer"></span><button class="btn" type="submit">Save</button></div>
          </form>` : ''}
        ${m.missing.length && m.ssoUrl ? html`<div class="alert warn"><span class="ico">⚙️</span><div>Still missing: ${m.missing.join(', ')}.</div></div>` : ''}
      </div>
      <div class="grid two">
        <form id="auth" class="card" novalidate>
          <h2>🚪 Who can get in</h2>
          <label class="check" style="margin-bottom:12px"><input type="checkbox" name="otpEnabled" ${s.auth.otpEnabled ? 'checked' : ''}><span><b>Email sign-in codes</b><br><span class="muted">A 6-digit code, valid 10 minutes, 5 tries. Needs the mail relay.</span></span></label>
          <label class="check" style="margin-bottom:12px"><input type="checkbox" name="selfSignup" ${s.auth.selfSignup ? 'checked' : ''}><span><b>Open sign-up</b><br><span class="muted">Anyone can sign up with an email code - nobody needs to be loaded first. Leave off to admit only people you load.</span></span></label>
          <div class="field"><label for="sd">Only these email domains <span class="muted">(optional)</span></label><input id="sd" name="signupDomains" value="${s.auth.signupDomains}" placeholder="avro.com, example.org">
            <div class="hint">Empty = any address. Applies to open sign-up only.</div></div>
          <label class="check" style="margin-bottom:12px"><input type="checkbox" name="azureEnabled" ${s.auth.azureEnabled ? 'checked' : ''}><span><b>Show "Sign in with Microsoft"</b> (OpenID Connect)<br><span class="muted">When it is configured below.</span></span></label>
          <label class="check" style="margin-bottom:12px"><input type="checkbox" name="azureAutoProvision" ${s.auth.azureAutoProvision ? 'checked' : ''}><span><b>Let anyone from single sign-on join</b><br><span class="muted">SAML and OpenID Connect: a new account is made at the first sign-in. Off: only people already loaded can sign in.</span></span></label>
          <div class="form-actions"><button class="btn" type="submit">Save</button></div>
        </form>
        <div class="card">
          <h2>🔑 Microsoft via OpenID Connect</h2>
          <p class="muted">The alternative to SAML: an app registration with a client secret. Set up through the env file, not here.</p>
          ${a.configured ? html`<div class="alert ok"><span class="ico">✅</span><div>Configured for tenant <code>${a.tenantId}</code>.${m.enabled && m.configured ? ' SAML is on, so the sign-in button uses SAML.' : ''}</div></div>`
    : html`<div class="alert info"><span class="ico">ℹ️</span><div>Not configured (missing: ${a.missing.join(', ')}).</div></div>`}
          <ol style="padding-left:20px">
            <li>Register an application (type <b>Web</b>) with the redirect URI <code style="word-break:break-all">${a.redirectUri}</code></li>
            <li>Save a client secret, alone, in <code>${a.secretFile}</code>.</li>
            <li>Set <code>SANTA_AZURE_TENANT_ID</code> and <code>SANTA_AZURE_CLIENT_ID</code> in the env file and redeploy.</li>
          </ol>
          <div class="row"><button class="btn ghost" data-act="azure-test">🔌 Test the connection</button><span class="muted" data-azure-result></span></div>
        </div>
      </div>`);
    bind();
  };

  const showErr = (msg) => {
    const box = main.querySelector('[data-md-err]');
    box.textContent = msg;
    box.hidden = !msg;
  };
  const configure = async (body) => {
    showErr('');
    try {
      s.saml = await api.post('/api/admin/saml/metadata', body);
      toast(`SAML configured from ${s.saml.idpEntityId} ✅`, 'ok');
      draw();
    } catch (ex) { showErr(errorText(ex)); }
  };

  function bind() {
    main.querySelector('#md-file').addEventListener('change', async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      if (f.size > 3 * 1024 * 1024) { showErr('That file is too large to be SAML metadata'); return; }
      await configure({ xml: await f.text() });
    });
    const sf = main.querySelector('#saml');
    if (sf) {
      sf.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        try { s.saml = await api.put('/api/admin/saml', formValues(sf)); toast('Saved 🔐', 'ok'); draw(); } catch (ex) { toast(errorText(ex), 'error'); }
      });
    }
    main.querySelector('#auth').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      try { await api.put('/api/admin/settings/auth', formValues(ev.target)); toast('Saved 🔐', 'ok'); } catch (ex) { toast(errorText(ex), 'error'); }
    });
  }

  actions(main, {
    copy: async (d) => {
      try { await navigator.clipboard.writeText(d.v); toast('Copied 📋', 'ok'); } catch { toast(d.v); }
    },
    'md-text': async () => {
      const xml = main.querySelector('#md-xml').value.trim();
      const url = main.querySelector('#md-url').value.trim();
      await configure(xml ? { xml } : { url });
    },
    'saml-remove': async () => {
      if (!await confirmBox('Remove the SAML configuration?', { ok: 'Remove', danger: true, detail: 'The SAML sign-in button disappears. Email codes and the admin password keep working.' })) return;
      s.saml = await api.del('/api/admin/saml');
      draw();
    },
    'azure-test': async () => {
      const out = main.querySelector('[data-azure-result]');
      out.textContent = 'Testing…';
      const r = await api.post('/api/admin/settings/azure/test');
      out.textContent = `${r.ok ? '✅' : '⛔'} ${r.message}`;
    },
  });
  draw();
}

// ---- outbox ------------------------------------------------------------------------------------
export async function outboxView(main, { isCurrent }) {
  let status = '';
  let o = await api.get('/api/admin/outbox');
  if (!isCurrent()) return;
  const badge = { sent: 'ok', captured: 'gold', queued: 'blue', failed: 'error' };
  const draw = () => mount(main, html`
    <div class="page-head"><div><h1>📮 Outbox</h1><p class="sub">Every email the app has written, so you can see that mail is flowing. Game emails are sealed - no recipient, no contents - because they could give away who is whose Santa. The <a href="#/admin/email">Email</a> page has a preview of each one. Sign-in codes are stored blanked out.</p></div>
      <div class="row">${o.counts.failed ? html`<button class="btn gold" data-act="retry">↻ Retry ${plural(o.counts.failed, 'failed email')}</button>` : ''}
        <button class="btn ghost" data-act="clear">🧹 Clear the log</button></div></div>
    ${adminNav('/admin/outbox')}
    <div class="row" style="margin-bottom:12px">
      ${[['', 'All'], ['queued', 'Queued'], ['sent', 'Sent'], ['captured', 'Demo (not sent)'], ['failed', 'Failed']].map(([k, l]) => html`
        <button class="btn small ${status === k ? '' : 'ghost'}" data-act="filter" data-s="${k}">${l}${k && o.counts[k] ? ` (${o.counts[k]})` : ''}</button>`)}
    </div>
    ${o.rows.length ? html`<div class="table-wrap"><table class="table">
      <thead><tr><th>When</th><th>To</th><th>Subject</th><th>Status</th><th></th></tr></thead>
      <tbody>${o.rows.map((r) => html`<tr>
        <td class="nowrap">${fmtDateTime(r.createdAt)}</td><td>${r.sealed ? html`<span class="muted">🔒 sealed</span>` : html`${r.toName ? html`${r.toName}<br>` : ''}<span class="muted">${r.to}</span>`}</td>
        <td>${r.subject}${r.error ? html`<div class="muted" style="color:var(--error)">${r.error}</div>` : ''}</td>
        <td><span class="badge ${badge[r.status]}">${r.status === 'captured' ? 'demo' : r.status}</span></td>
        <td>${r.sealed ? '' : html`<button class="btn link small" data-act="view" data-id="${r.id}">View</button>`}</td></tr>`)}</tbody></table></div>`
    : html`<div class="card empty"><span class="big-emoji">📭</span>No emails here.</div>`}`);
  draw();
  const reload = async () => { o = await api.get(`/api/admin/outbox${status ? `?status=${status}` : ''}`); draw(); };
  actions(main, {
    filter: (d) => { status = d.s; reload(); },
    view: (d) => { emailPreview(`/api/admin/outbox/${d.id}/html`, 'Email'); },
    retry: async () => { const r = await api.post('/api/admin/outbox/retry'); toast(`${plural(r.retried, 'email')} queued again`); reload(); },
    clear: async () => {
      if (!await confirmBox('Clear sent, demo and failed emails from the log? Queued ones stay.', { ok: 'Clear', danger: true })) return;
      await api.del('/api/admin/outbox');
      reload();
    },
  });
}

// ---- audit -----------------------------------------------------------------------------------------
export async function auditView(main, { isCurrent }) {
  const rows = await api.get('/api/admin/audit');
  if (!isCurrent()) return;
  mount(main, html`
    <div class="page-head"><div><h1>📜 Audit log</h1><p class="sub">Who did what - including every look at a team's full Santa list.</p></div></div>
    ${adminNav('/admin/audit')}
    <div class="table-wrap"><table class="table"><thead><tr><th>When</th><th>Who</th><th>What</th><th>Detail</th></tr></thead>
      <tbody>${rows.map((r) => html`<tr><td class="nowrap">${fmtDateTime(r.createdAt)}</td><td>${r.actor || html`<span class="muted">system</span>`}</td><td>${r.action}</td><td>${r.detail}</td></tr>`)}</tbody></table></div>`);
}

// ---- guidelines -----------------------------------------------------------------------------
export async function guidelinesView(main, { isCurrent }) {
  const s = await api.get('/api/admin/settings');
  if (!isCurrent()) return;
  mount(main, html`
    <div class="page-head"><div><h1>📜 Guidelines</h1><p class="sub">What everyone sees under "How to play". Each team can add its own house rules in its settings.</p></div>
      <a class="btn ghost" href="#/guide">👀 See it as a player</a></div>
    ${adminNav('/admin/guidelines')}
    <div class="grid two">
      <form id="guide" class="card" novalidate>
        <h2>✏️ Write</h2>
        <div class="field"><label class="sr-only" for="gtext">Guidelines</label>
          <textarea id="gtext" name="text" maxlength="20000" style="min-height:420px;font-family:var(--mono);font-size:.9rem">${s.guidelines.text}</textarea>
          <div class="hint"><code># Heading</code> · <code>## Smaller heading</code> · <code>- bullet</code> · <code>1. step</code> · <code>**bold**</code> · <code>*italic*</code> · <code>[link](https://...)</code></div></div>
        <div class="alert error" data-err hidden></div>
        <div class="form-actions"><button class="btn" type="submit">Save guidelines</button></div>
      </form>
      <div class="card ribbon"><div class="card-body" id="gpreview">${markdown(s.guidelines.text)}</div></div>
    </div>`);
  const form = main.querySelector('#guide');
  const ta = main.querySelector('#gtext');
  const preview = main.querySelector('#gpreview');
  ta.addEventListener('input', () => { preview.innerHTML = String(markdown(ta.value)); });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = form.querySelector('[data-err]');
    err.hidden = true;
    try {
      await api.put('/api/admin/settings/guidelines', { text: ta.value });
      toast('Guidelines saved 📜', 'ok');
    } catch (ex) { err.textContent = errorText(ex); err.hidden = false; }
  });
}

// ---- games (platform view) ------------------------------------------------------------------
// Every game and who organises it. Admins do not run games - they can hand one
// to a new organiser (say the old one left) or delete it.
export async function gamesView(main, { isCurrent }) {
  let games = await api.get('/api/admin/games');
  if (!isCurrent()) return;
  const draw = () => mount(main, html`
    <div class="page-head"><div><h1>🎄 Games</h1><p class="sub">${plural(games.length, 'game')} on the platform. Each one belongs to its organiser, who alone can see who plays and who drew whom; here you can only hand one over or delete it.</p></div></div>
    ${adminNav('/admin/games')}
    ${games.length ? html`<div class="table-wrap"><table class="table table-cards">
      <thead><tr><th>Game</th><th>Organiser</th><th>Status</th><th>Dates</th><th class="num">Players</th><th>Created</th><th></th></tr></thead>
      <tbody>${games.map((g) => html`<tr>
        <td class="first"><b>${g.name}</b> ${g.joinOpen ? html`<span class="badge blue">open sign-up</span>` : ''}</td>
        <td data-label="Organiser">${g.owner ? html`${g.owner.name}<div class="muted" style="font-size:.8rem">${g.owner.email || ''}</div>` : html`<span class="badge warn">nobody - hand it over</span>`}</td>
        <td data-label="Status">${phaseBadge(g.phase)}</td>
        <td data-label="Dates" class="nowrap">${fmtShort(g.startDate)} - ${fmtShort(g.endDate)}</td>
        <td data-label="Players" class="num">${g.memberCount}</td>
        <td data-label="Created" class="nowrap">${fmtDateTime(g.createdAt)}</td>
        <td class="nowrap"><button class="btn link small" data-act="owner" data-id="${g.id}">Change organiser</button>
          <button class="btn danger-link small" data-act="delete" data-id="${g.id}">Delete</button></td></tr>`)}</tbody></table></div>`
    : html`<div class="card empty"><span class="big-emoji">🎄</span>No games yet. Anyone signed in can create one from their home page.</div>`}`);
  draw();
  const reload = async () => { games = await api.get('/api/admin/games'); draw(); };
  actions(main, {
    owner: async (d) => {
      const g = games.find((x) => String(x.id) === d.id);
      const people = (await api.get('/api/admin/users')).filter((u) => u.active && u.role !== 'admin');
      const ok = await formModal({
        title: `🎄 New organiser for ${g.name}`,
        submit: 'Hand it over',
        body: html`<p class="muted">The new organiser runs the game from their home page. If they also play in it, they'll be asked to accept that they can see the Santa list. Admin accounts can't organise games, and a game with players can only go to one of them.</p>
          <div class="field"><label for="no">New organiser</label><select id="no" name="userId">${people.map((u) => html`<option value="${u.id}" ${g.owner && g.owner.id === u.id ? 'selected' : ''}>${u.name}${u.email ? ` (${u.email})` : ''}</option>`)}</select></div>`,
        onSubmit: (v) => api.put(`/api/admin/games/${g.id}/owner`, { userId: v.userId }),
      });
      if (ok) { toast('Handed over 🎁', 'ok'); reload(); }
    },
    delete: async (d) => {
      const g = games.find((x) => String(x.id) === d.id);
      if (!await confirmBox(`Delete ${g.name}?`, { ok: 'Delete game', danger: true, detail: 'Its draw, gifts, tasks and notes go with it. This cannot be undone.' })) return;
      await api.del(`/api/admin/games/${g.id}`);
      toast('Game deleted');
      reload();
    },
  });
}
