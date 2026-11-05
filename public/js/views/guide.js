import { api, html, mount, markdown, fmtDate, fmtShort } from '../lib.js';

// "How to play": the organiser's guidelines, then each of my games' own rules
// and key dates.
export async function guideView(main, { isCurrent, session }) {
  const g = await api.get('/api/guide');
  if (!isCurrent()) return;
  mount(main, html`
    <div class="page-head"><div><h1>📜 How to play</h1><p class="sub">The guidelines from your organiser - have a read, then have fun!</p></div>
      ${session.user.role === 'admin' ? html`<a class="btn ghost" href="#/admin/guidelines">✏️ Edit guidelines</a>` : ''}</div>
    <div class="grid side">
      <div class="card ribbon"><div class="card-body">${g.text ? markdown(g.text) : html`<p class="muted">Your organiser hasn't written any guidelines yet.</p>`}</div></div>
      <aside class="stack">
        ${g.teams.map((t) => html`
          <div class="card">
            <h3>🎄 ${t.name}</h3>
            <ul class="list">
              ${t.locationDeadline ? html`<li><span class="emoji">📍</span><div class="grow"><b>Check in</b> by ${fmtDate(t.locationDeadline)}<div class="meta">Tell us where you play from - or sit this one out.</div></div></li>` : ''}
              <li><span class="emoji">🎁</span><div class="grow"><b>Gift giving</b> ${fmtShort(t.startDate)} - ${fmtDate(t.endDate)}</div></li>
              ${t.budget ? html`<li><span class="emoji">💰</span><div class="grow"><b>Budget</b> ${t.budget}</div></li>` : ''}
            </ul>
            ${t.guidelines ? html`<hr>${markdown(t.guidelines)}` : ''}
            <a class="btn ghost small" href="#/team/${t.id}">Open the game</a>
          </div>`)}
        <div class="card tight">
          <p class="muted" style="margin:0">🔕 Too many emails? Switch on <a href="#/profile">Do not disturb</a> - you'll still see everything here.</p>
        </div>
      </aside>
    </div>`);
}
