import {
  api, html, mount, actions, fmtDate, fmtShort, ago, phaseBadge, plural, toast, formModal, confirmBox,
  avatar, extLink, todayStr, daysBetween, markdown,
} from '../lib.js';

// The four phases of a game, with where we are now.
function timeline(v) {
  const t = v.team;
  const setup = t.phase === 'setup';
  const open = v.checkIn.open;
  const steps = [
    ['📍', 'Check in', t.locationDeadline ? `until ${fmtShort(t.locationDeadline)}` : 'before the draw', setup ? (open ? 'now' : 'done') : 'done'],
    ['🎩', 'Names drawn', t.drawnAt ? fmtShort(t.drawnAt.slice(0, 10)) : 'coming soon', setup ? (open ? 'next' : 'now') : 'done'],
    ['🎁', 'Gift giving', `${fmtShort(t.startDate)} - ${fmtShort(t.endDate)}`, t.phase === 'live' ? 'now' : t.phase === 'ended' ? 'done' : 'next'],
    ['🎉', 'The big reveal', t.revealMode === 'after_end' ? `after ${fmtShort(t.endDate)}` : 'organiser decides', t.revealed ? 'done' : t.phase === 'ended' ? 'now' : 'next'],
  ];
  return html`<div class="timeline-card"><div class="timeline" role="list" aria-label="Game phases">${steps.map(([icon, label, when, state]) => html`
    <div class="step ${state}" role="listitem" aria-current="${state === 'now' ? 'step' : 'false'}"><div class="dot">${state === 'done' ? '✓' : icon}</div>
      <div class="label">${label}</div><div class="when">${when}</div></div>`)}</div></div>`;
}

// Phase 1: check in (where I play from), or sit this one out.
function checkInCard(v, locations) {
  const t = v.team;
  const me = v.me;
  if (me.optedOut) {
    return html`<div class="card">
      <h3>🛋️ Sitting this one out</h3>
      <p>No problem at all - Secret Santa should only ever be fun. You won't be matched or emailed about ${t.name}.</p>
      ${v.canOptOut ? html`<button class="btn" data-act="sit-in">🎄 Count me back in</button>`
    : html`<p class="muted">Names have been drawn - if you'd like to join after all, have a word with your organiser.</p>`}
    </div>`;
  }
  if (t.phase !== 'setup') {
    return html`<div class="card"><h3>📍 Where you play from</h3><p>You play from <b>${me.locationName || 'no location'}</b>.</p>
      <p class="muted">Names have been drawn, so have a word with your organiser if this changed.</p></div>`;
  }
  const sitOut = html`<hr><p class="muted" style="margin-bottom:6px">Not feeling it this year? That's completely okay. 💛</p>
    <button class="btn ghost small" data-act="sit-out">🛋️ Sit this one out</button>
    ${t.joinOpen ? html` <button class="btn danger-link small" data-act="leave">Leave this game</button>` : ''}`;
  if (!v.checkIn.open) {
    return html`<div class="card"><h3>📍 Where you play from</h3>
      <p>${me.locationName ? html`You play from <b>${me.locationName}</b>.` : 'No location yet.'}</p>
      <p class="muted">Check-in closed on ${fmtDate(v.checkIn.deadline)} - have a word with your organiser if this changed.</p>${sitOut}</div>`;
  }
  return html`<div class="card">
    <div class="card-title"><h3>📍 Step 1: check in</h3><span class="spacer"></span>
      ${me.confirmedAt ? html`<span class="badge ok">✓ checked in</span>` : html`<span class="badge gold">when you're ready</span>`}</div>
    <p class="muted">Where are you playing from? You'll be paired with people nearby.${v.checkIn.deadline ? ` Any time before ${fmtDate(v.checkIn.deadline)} is perfect.` : ''}</p>
    <form id="loc-form">
      <div class="field"><label for="myloc">I'm playing from</label>
        <select id="myloc" name="locationId">
          <option value="">My usual location${!me.teamLocationId && me.locationName ? ` (${me.locationName})` : ''}</option>
          ${locations.map((l) => html`<option value="${l.id}" ${me.teamLocationId === l.id ? 'selected' : ''}>${l.name}</option>`)}
        </select></div>
      <button class="btn block" type="submit">${me.confirmedAt ? '📍 Update my location' : '✅ Check me in'}</button>
    </form>
    ${sitOut}
  </div>`;
}

const HINT_LABELS = { likes: '💚 Loves', dislikes: '🚫 Not a fan of', hobbies: '🎨 Hobbies', colours: '🌈 Favourite colours', sizes: '📏 Sizes', note: '📝 A note' };
const PRIORITY = { 1: ['🌟', 'Top wish'], 2: ['🎁', 'Would love'], 3: ['🍬', 'Nice to have'] };

const giftFields = (g = {}, team) => html`
  <div class="field"><label for="g-desc">What is the gift?</label>
    <input id="g-desc" name="description" required maxlength="300" value="${g.description || ''}" placeholder="A mug of hot cocoa on their desk"></div>
  <div class="form-grid">
    <div class="field"><label for="g-date">Given on</label><input id="g-date" name="givenOn" type="date" value="${g.givenOn || todayStr()}" min="${team.startDate}" max="${team.endDate}"></div>
    <div class="field"><label for="g-url">Link <span class="muted">(optional)</span></label><input id="g-url" name="url" type="url" value="${g.url || ''}" placeholder="https://"></div>
  </div>
  <label class="check"><input type="checkbox" name="isFinal" ${g.isFinal ? 'checked' : ''}><span><b>🏆 This is the final gift</b><br><span class="muted">The big one at the end of the game. Only one gift can be the final one.</span></span></label>
  <p class="muted" style="margin-top:12px">Your child is told a gift is coming - never who it's from.</p>`;

const taskFields = (t = {}, team) => html`
  <div class="field"><label for="t-title">The fun task</label>
    <input id="t-title" name="title" required maxlength="160" value="${t.title || ''}" placeholder="Wear a festive jumper to Friday's meeting"></div>
  <div class="field"><label for="t-det">Details <span class="muted">(optional)</span></label>
    <textarea id="t-det" name="details" maxlength="1000" placeholder="Bonus points for jingle bells">${t.details || ''}</textarea></div>
  <div class="field"><label for="t-due">Due by <span class="muted">(optional)</span></label>
    <input id="t-due" name="dueDate" type="date" value="${t.dueDate || ''}" min="${todayStr()}" max="${team.endDate}"></div>
  <p class="muted">🧝 Everyone in the team sees this task on the task board (but never who set it). Keep it kind and fun!</p>`;

function chatBox(thread, side, enabled) {
  return html`
    <div class="chat" id="chat-${side}">
      ${thread.length ? thread.map((m) => html`<div class="bubble ${m.mine ? 'mine' : 'theirs'}">${m.body}<span class="when">${ago(m.createdAt)}</span></div>`)
    : html`<p class="muted" style="text-align:center">No notes yet. ${side === 'child' ? 'Ask your child a sneaky question - they will only see "your Secret Santa".' : 'Ask your Santa anything - they know who you are, you don\'t know who they are!'}</p>`}
    </div>
    ${enabled ? html`
      <form class="chat-form" data-chat="${side}">
        <textarea name="body" maxlength="1000" placeholder="${side === 'child' ? 'Psst... tea or coffee? 🤫' : 'Thank you, Santa! 🎄'}" aria-label="Write a note"></textarea>
        <button class="btn" type="submit">Send</button>
      </form>` : html`<p class="muted">Notes are closed for this game.</p>`}`;
}

function liveNotice(v) {
  const t = v.team;
  if (t.phase === 'drawn') return html`<div class="alert gold"><span class="ico">⏳</span><div>The game starts on <b>${fmtDate(t.startDate)}</b> (in ${plural(daysBetween(todayStr(), t.startDate), 'day')}). You can already look at your child's wishlist and send notes; gifts and tasks open on day one.</div></div>`;
  if (t.phase === 'ended') return html`<div class="alert info"><span class="ico">🎁</span><div>This game ended on <b>${fmtDate(t.endDate)}</b>. Everything is kept here as a happy memory.</div></div>`;
  return '';
}

function childTab(v, thread) {
  const c = v.child;
  if (!c) {
    return html`<div class="card empty"><span class="big-emoji">🎟️</span><h2>${v.team.phase === 'setup' ? 'Names have not been drawn yet' : 'You are not in the circle yet'}</h2>
      <p>${v.team.phase === 'setup' ? 'Once the organiser draws names, your child will appear here.' : 'The organiser will slot you in shortly.'}</p></div>`;
  }
  const hints = Object.entries(c.hints).filter(([, val]) => val);
  const final = c.giftsGiven.find((g) => g.isFinal);
  return html`
    ${liveNotice(v)}
    <div class="grid side">
      <div class="stack">
        <div class="card ribbon"><div class="card-body">
          <div class="gift-tag">
            <div class="label">You are Secret Santa for</div>
            <div class="value">${c.name}</div>
            <div class="sub">${c.location ? html`📍 playing from ${c.location}` : 'no location given'}${v.team.budget ? html` · 💰 ${v.team.budget}` : ''}</div>
          </div>
          <p class="muted" style="margin:12px 0 0;text-align:center">🤫 Shh - they can't see that it's you.</p>
        </div></div>

        <div class="card">
          <div class="card-title"><h2>🎁 ${c.name.split(' ')[0]}'s wishlist</h2><span class="badge">${plural(c.wishlist.length, 'wish', 'wishes')}</span></div>
          ${c.wishlist.length ? html`<ul class="list">${c.wishlist.map((w) => html`
            <li><span class="emoji" title="${PRIORITY[w.priority][1]}">${PRIORITY[w.priority][0]}</span>
              <div class="grow"><div class="title">${w.title}</div>
                ${w.notes ? html`<div class="meta" style="white-space:pre-line">${w.notes}</div>` : ''}
                ${w.url ? html`<div class="meta">${extLink(w.url)}</div>` : ''}</div>
              <span class="badge ${w.priority === 1 ? 'red' : ''}">${PRIORITY[w.priority][1]}</span></li>`)}</ul>`
    : html`<div class="empty"><span class="big-emoji">📭</span>Their wishlist is empty. Send an anonymous note to nudge them - or check their hints!</div>`}
        </div>

        <div class="card">
          <div class="card-title"><h2>🛷 Gifts you've given</h2><span class="spacer"></span>
            ${v.canPlay ? html`<button class="btn red small" data-act="add-gift">+ Log a gift</button>` : ''}</div>
          ${final ? html`<div class="alert gold"><span class="ico">🏆</span><div>Final gift: <b>${final.description}</b></div></div>` : (v.canPlay ? html`<p class="muted">Leave as many little surprises as you like during the game, and mark one as the <b>final gift</b>.</p>` : '')}
          ${c.giftsGiven.length ? html`<ul class="list">${c.giftsGiven.map((g) => html`
            <li><span class="emoji">${g.isFinal ? '🏆' : '🎁'}</span>
              <div class="grow"><div class="title">${g.description} ${g.isFinal ? html`<span class="badge gold">final gift</span>` : ''}</div>
                <div class="meta">${fmtDate(g.givenOn)}${g.url ? html` · ${extLink(g.url)}` : ''} · ${g.receivedAt ? html`<span class="badge ok">✓ received</span>` : html`<span class="badge">not marked received yet</span>`}</div>
                ${g.thanks ? html`<div class="alert ok" style="margin:8px 0 0"><span class="ico">💌</span><div>"${g.thanks}"</div></div>` : ''}</div>
              ${v.canPlay ? html`<div class="actions">
                <button class="btn link small" data-act="edit-gift" data-id="${g.id}">Edit</button>
                ${g.receivedAt ? '' : html`<button class="btn danger-link small" data-act="del-gift" data-id="${g.id}">Delete</button>`}</div>` : ''}</li>`)}</ul>`
    : html`<div class="empty"><span class="big-emoji">🛷</span>No gifts logged yet.</div>`}
        </div>

        <div class="card">
          <div class="card-title"><h2>🧝 Fun tasks you've set</h2><span class="spacer"></span>
            ${v.canPlay ? html`<button class="btn small" data-act="add-task">+ Set a fun task</button>` : ''}</div>
          ${c.tasksGiven.length ? html`<ul class="list">${c.tasksGiven.map((t) => html`
            <li><span class="emoji">${t.status === 'done' ? '✅' : '⏳'}</span>
              <div class="grow"><div class="title">${t.title}</div>
                ${t.details ? html`<div class="meta" style="white-space:pre-line">${t.details}</div>` : ''}
                <div class="meta">${t.dueDate ? `due ${fmtDate(t.dueDate)} · ` : ''}${t.status === 'done' ? html`<span class="badge ok">done ${ago(t.doneAt)}</span>` : html`<span class="badge warn">waiting</span>`}</div>
                ${t.doneNote ? html`<div class="alert ok" style="margin:8px 0 0"><span class="ico">💬</span><div>"${t.doneNote}"</div></div>` : ''}</div>
              ${v.canPlay && t.status !== 'done' ? html`<div class="actions">
                <button class="btn link small" data-act="edit-task" data-id="${t.id}">Edit</button>
                <button class="btn danger-link small" data-act="del-task" data-id="${t.id}">Delete</button></div>` : ''}</li>`)}</ul>`
    : html`<div class="empty"><span class="big-emoji">🧝</span>${v.canPlay ? 'Set your child a silly, kind challenge - the whole team will see it on the task board.' : 'No tasks set.'}</div>`}
        </div>
      </div>

      <aside class="stack">
        ${hints.length ? html`<div class="card"><h3>⭐ Hints from ${c.name.split(' ')[0]}</h3>
          <div class="stack">${hints.map(([k, val]) => html`<div class="hint-box"><div class="k">${HINT_LABELS[k]}</div><div class="v">${val}</div></div>`)}</div></div>` : ''}
        <div class="card">
          <div class="card-title">${avatar(c.name)}<div><h3>Notes with ${c.name.split(' ')[0]}</h3><div class="muted" style="font-size:.85rem">They see you as "your Secret Santa"</div></div></div>
          ${chatBox(thread, 'child', v.canMessage)}
        </div>
      </aside>
    </div>`;
}

function santaTab(v, thread) {
  const f = v.fromSanta;
  if (!f.hasSanta) {
    return html`<div class="card empty"><span class="big-emoji">🎅</span><h2>No Santa yet</h2><p>${v.team.phase === 'setup' ? 'Names have not been drawn.' : 'The organiser will slot you in shortly.'}</p></div>`;
  }
  const final = f.gifts.find((g) => g.isFinal);
  return html`
    ${liveNotice(v)}
    <div class="grid side">
      <div class="stack">
        <div class="card hero" style="text-align:center">
          ${f.santaName ? html`<div style="font-size:3rem">🎉</div><h2 style="color:#fff">Your Secret Santa was</h2><div style="font:bold 2.2rem var(--serif)">${f.santaName}</div><p class="muted">Go on, give them a big festive thank-you!</p>`
    : html`<div style="font-size:3rem">🤫</div><h2 style="color:#fff">Your Secret Santa is&hellip;</h2><div style="font:bold 2rem var(--serif)">a mystery!</div>
              <p class="muted">${v.team.revealMode === 'after_end' ? `All is revealed after ${fmtDate(v.team.endDate)}.` : 'The organiser will reveal the Santas when the time is right.'}</p>`}
        </div>
        <div class="card">
          <div class="card-title"><h2>🎁 Gifts from your Santa</h2>${final ? html`<span class="badge gold">🏆 final gift arrived!</span>` : ''}</div>
          ${f.gifts.length ? html`<ul class="list">${f.gifts.map((g) => html`
            <li><span class="emoji">${g.isFinal ? '🏆' : '🎁'}</span>
              <div class="grow"><div class="title">${g.description} ${g.isFinal ? html`<span class="badge gold">final gift</span>` : ''}</div>
                <div class="meta">${fmtDate(g.givenOn)}${g.url ? html` · ${extLink(g.url)}` : ''}</div>
                ${g.thanks ? html`<div class="meta">💌 You said: "${g.thanks}"</div>` : ''}</div>
              <div class="actions">${g.receivedAt
    ? html`<span class="badge ok">✓ received</span> <button class="btn link small" data-act="thank" data-id="${g.id}">Edit note</button>`
    : html`<button class="btn small" data-act="thank" data-id="${g.id}">Got it! Say thanks</button>`}</div></li>`)}</ul>`
    : html`<div class="empty"><span class="big-emoji">🎄</span>Nothing yet... keep an eye on your desk! 👀</div>`}
        </div>
        <div class="card">
          <h2>🧝 Missions from your Santa</h2>
          ${f.tasks.length ? html`<ul class="list">${f.tasks.map((t) => html`
            <li><span class="emoji">${t.status === 'done' ? '✅' : '🎯'}</span>
              <div class="grow"><div class="title">${t.title}</div>
                ${t.details ? html`<div class="meta" style="white-space:pre-line">${t.details}</div>` : ''}
                <div class="meta">${t.dueDate ? `due ${fmtDate(t.dueDate)}` : 'no deadline'}${t.doneNote ? html` · "${t.doneNote}"` : ''}</div></div>
              <div class="actions">${t.status === 'done'
    ? html`<span class="badge ok">done!</span> <button class="btn link small" data-act="undo-task" data-id="${t.id}">Undo</button>`
    : html`<button class="btn red small" data-act="done-task" data-id="${t.id}">Mark done</button>`}</div></li>`)}</ul>`
    : html`<div class="empty"><span class="big-emoji">🎯</span>No missions yet. Brace yourself...</div>`}
        </div>
      </div>
      <aside class="stack">
        <div class="card">
          <div class="card-title">${f.santaName ? avatar(f.santaName) : avatar('', { mystery: true })}<div><h3>Notes with your Santa</h3><div class="muted" style="font-size:.85rem">They know it's you - you don't know them</div></div></div>
          ${chatBox(thread, 'santa', v.canMessage)}
        </div>
      </aside>
    </div>`;
}

function boardTab(v, board, filter) {
  const shown = board.filter((t) => filter === 'all' || (filter === 'open' ? t.status === 'open' : t.status === 'done'));
  const done = board.filter((t) => t.status === 'done').length;
  return html`
    <div class="row between" style="margin-bottom:14px">
      <p class="muted" style="margin:0">Every fun task in ${v.team.name} - who it's for, never who set it. Cheer people on! 📣 ${board.length ? `${done} of ${board.length} done.` : ''}</p>
      <div class="row">
        ${['all', 'open', 'done'].map((f) => html`<button class="btn small ${f === filter ? '' : 'ghost'}" data-act="filter" data-f="${f}">${{ all: 'All', open: '⏳ Open', done: '✅ Done' }[f]}</button>`)}
      </div>
    </div>
    ${shown.length ? html`<div class="board">${shown.map((t) => html`
      <div class="task-card ${t.status === 'done' ? 'done' : ''}">
        <div class="who">${t.forMe ? '🎯 Mission for you' : `Mission for ${t.childName}`}</div>
        <div class="t">${t.title}</div>
        ${t.details ? html`<div class="d">${t.details}</div>` : ''}
        ${t.doneNote ? html`<div class="d">💬 "${t.doneNote}"</div>` : ''}
        <div class="foot">
          ${t.status === 'done' ? html`<span class="badge ok">✅ done</span>` : html`<span class="badge warn">${t.dueDate ? `⏳ by ${fmtShort(t.dueDate)}` : '⏳ open'}</span>`}
          ${t.byMe ? html`<span class="badge gold" title="Only you can see this">you set this</span>` : ''}
          <span class="spacer"></span>
          <button class="cheer-btn ${t.cheered ? 'on' : ''}" data-act="cheer" data-id="${t.id}" aria-pressed="${t.cheered ? 'true' : 'false'}">📣 ${t.cheers}</button>
        </div>
      </div>`)}</div>`
    : html`<div class="card empty"><span class="big-emoji">🧝</span>${board.length ? 'Nothing here with that filter.' : (v.team.phase === 'setup' ? 'Tasks appear once names are drawn and the game starts.' : 'No tasks yet - Santas, get creative!')}</div>`}`;
}

function teamTab(v, locations) {
  const t = v.team;
  const byLoc = new Map();
  for (const m of v.members) {
    const k = m.location || 'No location yet';
    if (!byLoc.has(k)) byLoc.set(k, []);
    byLoc.get(k).push(m);
  }
  return html`
    <div class="grid side">
      <div class="stack">
        <div class="card">
          <h2>📜 About this game</h2>
          ${t.description ? html`<p style="white-space:pre-line">${t.description}</p>` : ''}
          <div class="hints">
            <div class="hint-box"><div class="k">📅 Plays</div><div class="v">${fmtDate(t.startDate)} - ${fmtDate(t.endDate)}</div></div>
            ${t.budget ? html`<div class="hint-box"><div class="k">💰 Budget</div><div class="v">${t.budget}</div></div>` : ''}
            <div class="hint-box"><div class="k">📍 Matching</div><div class="v">${t.matchScope === 'all' ? 'Everyone together' : 'Within each location'}</div></div>
            <div class="hint-box"><div class="k">🎉 Reveal</div><div class="v">${t.revealMode === 'after_end' ? 'After the last day' : 'When the organiser says so'}</div></div>
          </div>
        </div>
        <div class="card">
          <div class="card-title"><h2>👥 Who's playing</h2><span class="badge">${plural(v.members.length, 'player')}</span>
            ${v.sittingOut ? html`<span class="badge" title="People who chose to sit this game out">🛋️ ${v.sittingOut} sitting out</span>` : ''}</div>
          ${[...byLoc.entries()].map(([loc, list]) => html`
            <h4 style="margin:14px 0 8px">📍 ${loc} <span class="muted">(${list.length})</span></h4>
            <div class="chips">${list.map((m) => html`<span class="chip">${avatar(m.name, { cls: 'tiny' })} ${m.name}</span>`)}</div>`)}
        </div>
      </div>
      <aside class="stack">
        ${checkInCard(v, locations)}
        ${t.guidelines ? html`<div class="card"><h3>📜 House rules</h3>${markdown(t.guidelines)}<a href="#/guide">All the guidelines →</a></div>`
    : html`<div class="card tight"><p class="muted" style="margin:0">📜 New here? <a href="#/guide">Read how to play</a>.</p></div>`}
      </aside>
    </div>`;
}

export async function teamView(main, { params, isCurrent }) {
  const teamId = params.id;
  const base = `/api/teams/${teamId}`;
  let [v, locations] = await Promise.all([api.get(base), api.get('/api/locations')]);
  if (!isCurrent()) return;
  const matched = v.team.phase !== 'setup';
  const tab = params.tab || (v.child ? 'child' : 'team');
  let filter = 'all';
  let board = [];
  let thread = [];

  const load = async () => {
    if (tab === 'board') board = await api.get(`${base}/board`);
    if (tab === 'child' && v.child) thread = await api.get(`${base}/messages/child`);
    if (tab === 'santa' && v.fromSanta.hasSanta) thread = await api.get(`${base}/messages/santa`);
  };

  const draw = () => {
    const tabs = [
      ['child', '🎅 My child', v.child ? v.child.unread : 0],
      ['santa', '🎁 From my Santa', v.fromSanta.unread + v.fromSanta.tasks.filter((t) => t.status === 'open').length],
      ['board', '🧝 Task board', 0],
      ['team', '👥 The team', 0],
    ];
    let body;
    if (tab === 'child') body = childTab(v, thread);
    else if (tab === 'santa') body = santaTab(v, thread);
    else if (tab === 'board') body = boardTab(v, board, filter);
    else body = teamTab(v, locations);
    mount(main, html`
      <div class="page-head">
        <div><h1>${v.team.name}</h1><p class="sub">📅 ${fmtShort(v.team.startDate)} - ${fmtDate(v.team.endDate)} · ${plural(v.members.length, 'player')}</p></div>
        ${phaseBadge(v.team.phase)}
      </div>
      ${timeline(v)}
      <nav class="tabs">${tabs.filter(([k]) => (matched && !v.me.optedOut) || k === 'team' || k === 'board').map(([k, label, n]) => html`
        <a href="#/team/${teamId}/${k}" class="${k === tab ? 'active' : ''}">${label}${n ? html`<span class="count">${n}</span>` : ''}</a>`)}</nav>
      ${body}`);
    for (const c of main.querySelectorAll('.chat')) c.scrollTop = c.scrollHeight;
    bindForms();
  };

  function bindForms() {
    for (const form of main.querySelectorAll('form[data-chat]')) {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const ta = form.querySelector('textarea');
        const body = ta.value.trim();
        if (!body) return;
        try {
          thread = await api.post(`${base}/messages/${form.dataset.chat}`, { body });
          draw();
          toast('Note sent 💌', 'ok');
        } catch (err) {
          toast(err.message, 'error');
        }
      });
      form.querySelector('textarea').addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) form.requestSubmit();
      });
    }
    const lf = main.querySelector('#loc-form');
    if (lf) {
      lf.addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
          const first = !v.me.confirmedAt;
          v = await api.put(`${base}/location`, { locationId: lf.locationId.value || null });
          toast(first ? `You're checked in from ${v.me.locationName}! 🎉` : 'Location updated 📍', 'ok');
          draw();
        } catch (err) {
          toast(err.message, 'error');
        }
      });
    }
  }

  const findGift = (gid) => (v.child ? v.child.giftsGiven : []).concat(v.fromSanta.gifts).find((g) => String(g.id) === String(gid));
  const findTask = (tid) => (v.child ? v.child.tasksGiven : []).concat(v.fromSanta.tasks).find((t) => String(t.id) === String(tid));

  actions(main, {
    'sit-out': async () => {
      const ok = await confirmBox(`No problem at all - Secret Santa is meant to be fun, never a chore. You won't be matched or emailed about ${v.team.name}, and you can change your mind any time before names are drawn.`, {
        title: '🛋️ Sit this one out?', ok: 'Sit this one out',
      });
      if (!ok) return;
      v = await api.post(`${base}/sit-out`, { out: true });
      toast('Got it - enjoy the festivities from the sofa! 🛋️☕', 'ok');
      draw();
    },
    'sit-in': async () => {
      v = await api.post(`${base}/sit-out`, { out: false });
      toast(`Welcome back to ${v.team.name}! 🎄`, 'ok');
      draw();
    },
    'add-gift': async () => {
      const out = await formModal({ title: `🎁 A gift for ${v.child.name}`, submit: 'Log gift', body: giftFields({}, v.team), onSubmit: (f) => api.post(`${base}/gifts`, f) });
      if (out && out.team) { v = out; draw(); toast('Gift logged - ho ho ho! 🎁', 'ok'); }
    },
    'edit-gift': async (d) => {
      const g = findGift(d.id);
      const out = await formModal({ title: 'Edit gift', body: giftFields(g, v.team), onSubmit: (f) => api.put(`${base}/gifts/${d.id}`, f) });
      if (out && out.team) { v = out; draw(); }
    },
    'del-gift': async (d) => {
      if (!await confirmBox('Delete this gift from the log?', { ok: 'Delete', danger: true })) return;
      v = await api.del(`${base}/gifts/${d.id}`);
      draw();
    },
    thank: async (d) => {
      const g = findGift(d.id);
      const out = await formModal({
        title: '💌 Got it!',
        submit: 'Send thanks',
        body: html`<p>Mark <b>${g.description}</b> as received and leave your Santa a thank-you note.</p>
          <div class="field"><label for="thx">Thank-you note <span class="muted">(optional)</span></label><textarea id="thx" name="thanks" maxlength="500" placeholder="You made my day, mystery Santa! ☕">${g.thanks || ''}</textarea></div>`,
        onSubmit: (f) => api.post(`${base}/gifts/${d.id}/received`, { received: true, thanks: f.thanks }),
      });
      if (out && out.team) { v = out; draw(); toast('Thanks sent to your Santa 💌', 'ok'); }
    },
    'add-task': async () => {
      const out = await formModal({ title: `🧝 A fun task for ${v.child.name}`, submit: 'Set task', body: taskFields({}, v.team), onSubmit: (f) => api.post(`${base}/tasks`, f) });
      if (out && out.team) { v = out; draw(); toast('Mission set! 🎯', 'ok'); }
    },
    'edit-task': async (d) => {
      const out = await formModal({ title: 'Edit task', body: taskFields(findTask(d.id), v.team), onSubmit: (f) => api.put(`${base}/tasks/${d.id}`, f) });
      if (out && out.team) { v = out; draw(); }
    },
    'del-task': async (d) => {
      if (!await confirmBox('Delete this task?', { ok: 'Delete', danger: true })) return;
      v = await api.del(`${base}/tasks/${d.id}`);
      draw();
    },
    'done-task': async (d) => {
      const t = findTask(d.id);
      const out = await formModal({
        title: '✅ Mission accomplished?',
        submit: 'Mark done',
        body: html`<p><b>${t.title}</b></p><div class="field"><label for="dn">How did it go? <span class="muted">(optional, everyone sees it)</span></label><textarea id="dn" name="note" maxlength="500" placeholder="Nailed it. The whole team sang along 🎶"></textarea></div>`,
        onSubmit: (f) => api.post(`${base}/tasks/${d.id}/done`, { done: true, note: f.note }),
      });
      if (out && out.team) { v = out; draw(); toast('Woohoo! Task done 🎉', 'ok'); }
    },
    'undo-task': async (d) => {
      v = await api.post(`${base}/tasks/${d.id}/done`, { done: false });
      draw();
    },
    cheer: async (d) => {
      board = await api.post(`${base}/tasks/${d.id}/cheer`);
      draw();
    },
    filter: (d) => { filter = d.f; draw(); },
    leave: async () => {
      if (!await confirmBox(`Leave ${v.team.name}?`, { ok: 'Leave', danger: true })) return;
      await api.post(`${base}/leave`);
      toast('You left the game');
      location.hash = '#/';
    },
  });

  await load();
  if (!isCurrent()) return;
  draw();
}
