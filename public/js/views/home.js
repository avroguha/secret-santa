// Home: create a game or join one, then the games you play in and the games
// you organise, plus a short to-do list.
import { api, html, mount, actions, fmtDate, fmtShort, phaseBadge, plural, toast, formModal } from '../lib.js';
import { createGameFlow } from './manage.js';
import { askForCode } from './join.js';

function countdownTo(target) {
  const ms = Math.max(0, target - Date.now());
  const d = Math.floor(ms / 86400e3);
  const h = Math.floor((ms % 86400e3) / 3600e3);
  const m = Math.floor((ms % 3600e3) / 60e3);
  return html`<div class="countdown" aria-label="${d} days ${h} hours ${m} minutes">
    <div class="unit"><b>${d}</b><span>days</span></div>
    <div class="unit"><b>${h}</b><span>hours</span></div>
    <div class="unit"><b>${m}</b><span>mins</span></div></div>`;
}

// The next moment worth counting down to across all my games.
function nextMilestone(teams) {
  const playing = teams.filter((t) => !t.optedOut);
  const live = playing.filter((t) => t.phase === 'live').sort((a, b) => a.endDate.localeCompare(b.endDate))[0];
  if (live) return { at: new Date(`${live.endDate}T23:59:59`), label: `left in ${live.name} - the final gift and the big reveal!` };
  const soon = playing.filter((t) => t.phase === 'drawn' || t.phase === 'setup').sort((a, b) => a.startDate.localeCompare(b.startDate))[0];
  if (soon) return { at: new Date(`${soon.startDate}T00:00:00`), label: `until ${soon.name} begins` };
  return null;
}

function teamCard(t) {
  let middle;
  if (t.optedOut) {
    middle = html`<div class="alert info" style="margin:0"><span class="ico">🛋️</span><div>You're sitting this one out - totally fine! ${t.phase === 'setup' ? 'Change your mind any time before names are drawn.' : ''}</div></div>`;
  } else if (t.needsCheckIn) {
    middle = html`<div class="gift-tag"><div class="label">Step 1 · check in</div><div class="value" style="font-size:1.6rem">📍 Where are you playing from?</div>
      <div class="sub">${t.locationDeadline ? `Whenever suits you before ${fmtDate(t.locationDeadline)}` : 'Whenever suits you, before names are drawn'}</div></div>`;
  } else if (t.phase === 'setup') {
    middle = html`<p class="muted" style="margin:0">✅ You're checked in. Names have not been drawn yet - polish your wishlist while you wait!</p>`;
  } else if (t.childName) {
    middle = html`<div class="gift-tag"><div class="label">You are Secret Santa for</div><div class="value">${t.childName}</div></div>`;
  } else {
    middle = html`<p class="muted" style="margin:0">You are not in the circle yet - the organiser will slot you in.</p>`;
  }
  return html`
    <a class="card ribbon" href="#/team/${t.id}${t.needsCheckIn || t.optedOut ? '/team' : ''}">
      <div class="card-body">
        <div class="row between"><h3 style="margin:0">${t.name}</h3>${phaseBadge(t.phase)}</div>
        <p class="muted" style="margin:0">📅 ${fmtShort(t.startDate)} - ${fmtDate(t.endDate)}${t.budget ? html` · 💰 ${t.budget}` : ''}</p>
        ${middle}
        ${t.santaName ? html`<div class="alert gold" style="margin:0"><span class="ico">🎉</span><div>Your Secret Santa was <b>${t.santaName}</b>!</div></div>` : ''}
        <div class="row" style="margin-top:auto">
          <span class="badge">👥 ${plural(t.memberCount, 'player')}</span>
          ${t.isOwner ? html`<span class="badge gold">🧝 you organise</span>` : ''}
          ${t.unread ? html`<span class="badge red">💌 ${plural(t.unread, 'new note')}</span>` : ''}
          ${t.openTasks ? html`<span class="badge warn">🧝 ${plural(t.openTasks, 'task')} for you</span>` : ''}
        </div>
      </div>
    </a>`;
}

function organiserCard(g) {
  return html`
    <div class="card">
      <div class="row between"><h3 style="margin:0">${g.name}</h3>${phaseBadge(g.phase)}</div>
      <p class="muted" style="margin:6px 0 10px">📅 ${fmtShort(g.startDate)} - ${fmtDate(g.endDate)} · 👥 ${plural(g.memberCount, 'player')}${g.sittingOut ? ` · 🛋️ ${g.sittingOut} sitting out` : ''}</p>
      ${g.phase === 'setup' && g.checkIn.total ? html`<p style="margin:0 0 10px">📍 ${g.checkIn.confirmed} of ${g.checkIn.total} checked in</p>` : ''}
      ${g.warnings.length ? html`<div class="stack" style="gap:6px;margin-bottom:10px">${g.warnings.map((w) => html`<div class="alert warn" style="margin:0;padding:8px 12px"><span class="ico">⚠️</span><div>${w.text.replace(`${g.name}: `, '')}</div></div>`)}</div>` : ''}
      <div class="row" style="margin-top:auto"><a class="btn small" href="#/manage/${g.id}">🧝 Manage</a>
        ${g.phase === 'setup' ? html`<a class="btn ghost small" href="#/manage/${g.id}/draw">🎩 Draw names</a>` : ''}</div>
    </div>`;
}

export async function homeView(main, { session, isCurrent, refresh }) {
  const [mine, me, wishes, locations] = await Promise.all([
    api.get('/api/me/teams'), api.get('/api/me'), api.get('/api/me/wishlist'), api.get('/api/locations'),
  ]);
  if (!isCurrent()) return;
  const first = session.user.name.split(' ')[0];
  const ms = nextMilestone(mine.teams);
  const nudges = [];
  for (const t of mine.teams.filter((x) => x.needsCheckIn)) {
    nudges.push(html`<li>📍 <a href="#/team/${t.id}/team">Check in for ${t.name}</a> - just tell us where you're playing from${t.locationDeadline ? ` (any time before ${fmtShort(t.locationDeadline)})` : ''}.</li>`);
  }
  if (!wishes.length) nudges.push(html`<li>🎁 Your wishlist is empty - <a href="#/wishlist">add a few wishes</a> so your Santa has ideas.</li>`);
  if (!me.locationId) nudges.push(html`<li>📍 You haven't said where you usually play from - <a href="#/profile">pick your location</a>.</li>`);
  if (Object.values(me.hints).filter(Boolean).length < 2) nudges.push(html`<li>⭐ Drop your Santa a few <a href="#/profile">hints about yourself</a> (likes, sizes, allergies).</li>`);

  mount(main, html`
    <div class="grid side">
      <div class="stack">
        <div class="card hero">
          <h1>Ho ho ho, ${first}! 🎅</h1>
          ${ms ? html`
            <div class="row" style="gap:16px">
              <div id="cd">${countdownTo(ms.at)}</div>
              <div class="muted" style="font-size:1.05rem;font-weight:700">${ms.label}</div>
            </div>` : html`<p class="muted" style="font-weight:600">Start a game for your team, or join one with an invite code.</p>`}
          <div class="actions-row">
            <button class="action-tile" data-act="create"><span class="big">🎄</span><span>Create a game<small>Organise one for your team</small></span></button>
            <button class="action-tile" data-act="join-code"><span class="big">🎟️</span><span>Join a game<small>Got an invite code or link?</small></span></button>
          </div>
        </div>

        <div class="section-title"><h2>🎅 Games you're in</h2></div>
        ${mine.teams.length ? html`<div class="grid cards">${mine.teams.map(teamCard)}</div>`
    : html`<div class="card empty"><span class="big-emoji">🦌</span><p>You're not in any game yet.</p>
            <div class="row" style="justify-content:center"><button class="btn red" data-act="join-code">🎟️ Join with a code</button><button class="btn" data-act="create">🎄 Create a game</button></div></div>`}

        ${mine.organising.length ? html`
          <div class="section-title"><h2>🧝 Games you organise</h2></div>
          <div class="grid cards">${mine.organising.map(organiserCard)}</div>` : ''}

        ${mine.joinable.length ? html`
          <div class="section-title"><h2>✨ Open for sign-ups</h2></div>
          <div class="grid cards">
            ${mine.joinable.map((t) => html`
              <div class="card">
                <h3>${t.name}</h3>
                <p class="muted">📅 ${fmtShort(t.startDate)} - ${fmtDate(t.endDate)} · 👥 ${plural(t.memberCount, 'player')}${t.budget ? html` · 💰 ${t.budget}` : ''}</p>
                ${t.description ? html`<p>${t.description}</p>` : ''}
                <div style="margin-top:auto"><button class="btn red" data-act="join" data-id="${t.id}" data-name="${t.name}">🙋 Count me in</button></div>
              </div>`)}
          </div>` : ''}
      </div>
      <aside class="stack">
        <div class="card">
          <h3>🧾 Your to-do list</h3>
          ${nudges.length ? html`<ul class="list">${nudges}</ul>` : html`<p style="margin:0">✅ All set - wishlist, location and hints are in. Nice work, elf!</p>`}
        </div>
        <div class="card">
          <h3>🎁 Your wishlist</h3>
          ${wishes.length ? html`<ul class="list">${wishes.slice(0, 5).map((w) => html`<li><span class="emoji">${['', '🌟', '🎁', '🍬'][w.priority]}</span><div class="grow"><div class="title">${w.title}</div></div></li>`)}</ul>` : html`<p class="muted">Nothing yet.</p>`}
          <a class="btn ghost small" href="#/wishlist">Edit wishlist</a>
        </div>
        <div class="card tight">
          <p class="muted" style="margin:0">🤫 <b>How it works:</b> you see only your child and their wishlist. Your Santa stays a mystery until the reveal. Fun tasks are on a board everyone in the game can see. <a href="#/guide">Read the guidelines →</a></p>
        </div>
      </aside>
    </div>`);

  if (ms) {
    const timer = setInterval(() => {
      const el = document.getElementById('cd');
      if (!el || !isCurrent()) { clearInterval(timer); return; }
      el.innerHTML = String(countdownTo(ms.at));
    }, 30000);
  }

  actions(main, {
    create: () => createGameFlow(mine.organising),
    'join-code': () => askForCode(),
    join: async (d) => {
      const ok = await formModal({
        title: `Join ${d.name}`,
        submit: 'Join the game',
        body: html`
          <p>Where will you be playing from? People are matched with others in the same location.</p>
          <div class="field"><label for="loc">Location</label>
            <select id="loc" name="locationId">
              <option value="">My usual location${me.locationName ? ` (${me.locationName})` : ''}</option>
              ${locations.map((l) => html`<option value="${l.id}">${l.name}</option>`)}
            </select></div>`,
        onSubmit: (v) => api.post(`/api/teams/${d.id}/join`, { locationId: v.locationId || null }),
      });
      if (ok) {
        toast(`You're in! 🎉 Welcome to ${d.name}`, 'ok');
        refresh();
      }
    },
  });
}
