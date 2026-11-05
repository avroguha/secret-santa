import {
  api, html, mount, actions, toast, formModal, confirmBox, fmtDate, fmtDateTime, fmtShort, phaseBadge, plural, avatar, todayStr, errorText,
} from '../lib.js';

const OWNER_ACK = 'I understand that as the organiser I can see the whole Santa list - including who my own Santa is.';

// The game's settings form - creating a game (home page) and the Settings tab.
export const teamForm = (t = {}, teams = []) => html`
  <div class="form-grid">
    <div class="field full"><label for="t-name">Game name</label><input id="t-name" name="name" required maxlength="80" value="${t.name || ''}" placeholder="Workshop Elves 2026"></div>
    <div class="field full"><label for="t-desc">Description <span class="muted">(players see this)</span></label>
      <textarea id="t-desc" name="description" maxlength="2000" placeholder="Small surprises all month, the final gift at the party!">${t.description || ''}</textarea></div>
    <div class="field"><label for="t-start">Game starts</label><input id="t-start" name="startDate" type="date" required value="${t.startDate || todayStr()}"></div>
    <div class="field"><label for="t-end">Game ends</label><input id="t-end" name="endDate" type="date" required value="${t.endDate || ''}">
      <div class="hint">Gifts and tasks can be logged between these dates.</div></div>
    <div class="field"><label for="t-checkin">Check-in closes <span class="muted">(phase 1, optional)</span></label><input id="t-checkin" name="locationDeadline" type="date" value="${t.locationDeadline || ''}">
      <div class="hint">Until then players confirm where they play from - or choose to sit out. Leave empty to keep check-in open until you draw names.</div></div>
    <div class="field"><label for="t-rdays">Gentle reminder days</label><input id="t-rdays" name="reminderDays" maxlength="40" value="${t.reminderDays !== undefined ? t.reminderDays : '3,1'}" placeholder="3,1">
      <div class="hint">Days before check-in closes (phase 1) and before the game ends (phase 2) when a soft, fun reminder goes out. "3,1" = three days before and the day before. Empty = none.</div></div>
    <div class="field"><label for="t-budget">Budget <span class="muted">(optional)</span></label><input id="t-budget" name="budget" maxlength="40" value="${t.budget || ''}" placeholder="$25"></div>
    <div class="field"><label for="t-scope">Who is matched with whom</label><select id="t-scope" name="matchScope">
      <option value="location" ${t.matchScope !== 'all' ? 'selected' : ''}>Within each location</option>
      <option value="all" ${t.matchScope === 'all' ? 'selected' : ''}>Everyone together</option></select></div>
    <div class="field"><label for="t-min">Smallest comfortable group</label><input id="t-min" name="minGroupSize" type="number" min="2" max="50" value="${t.minGroupSize || 3}">
      <div class="hint">Locations smaller than this are highlighted (it is easy to guess your Santa in a tiny group).</div></div>
    <div class="field"><label for="t-reveal">Reveal the Santas</label><select id="t-reveal" name="revealMode">
      <option value="after_end" ${t.revealMode !== 'manual' ? 'selected' : ''}>Automatically after the last day</option>
      <option value="manual" ${t.revealMode === 'manual' ? 'selected' : ''}>When I press "Reveal"</option></select></div>
    <div class="field full"><label class="check"><input type="checkbox" name="joinOpen" ${t.joinOpen ? 'checked' : ''}><span><b>Open for sign-ups</b> - listed on everyone's home page until names are drawn. Either way, people can join with your invite link.</span></label></div>
    <div class="field full"><label for="t-guide">House rules <span class="muted">(optional - shown on the game page)</span></label>
      <textarea id="t-guide" name="guidelines" maxlength="5000" placeholder="- The final gift is opened together at the party&#10;- Budget is $25 - homemade is wonderful too">${t.guidelines || ''}</textarea>
      <div class="hint">Simple formatting: <code># heading</code>, <code>- list</code>, <code>**bold**</code>. Everyone also sees the general guidelines under "How to play".</div></div>
    ${teams.length ? html`
      <div class="field"><label for="t-copy">Copy players from <span class="muted">(optional)</span></label><select id="t-copy" name="copyFrom"><option value="">Start empty</option>
        ${teams.map((x) => html`<option value="${x.id}">${x.name}</option>`)}</select></div>
      <div class="field"><label>&nbsp;</label><label class="check"><input type="checkbox" name="avoidPrevious" checked> Nobody gets the same person as last time</label></div>` : ''}
  </div>`;

// "Create a game", from the home page. The organiser may play too - after
// accepting that they will see the whole Santa list, their own Santa included.
export async function createGameFlow(myGames = []) {
  const id = await formModal({
    title: '🎄 Create a game',
    submit: 'Create the game',
    wide: true,
    body: html`
      ${teamForm({}, myGames)}
      <fieldset><legend>🎅 Will you play too?</legend>
        <label class="check"><input type="checkbox" name="ownerPlays" data-plays> <span><b>I'm playing in this game as well</b></span></label>
        <label class="check" data-ack hidden style="margin-top:10px"><input type="checkbox" name="ownerAck">
          <span>${OWNER_ACK} <span class="muted">(Organisers can open the Santa list to sort out problems.)</span></span></label>
      </fieldset>`,
    onOpen: (dlg) => {
      const plays = dlg.querySelector('[data-plays]');
      plays.addEventListener('change', () => { dlg.querySelector('[data-ack]').hidden = !plays.checked; });
    },
    onSubmit: async (v) => {
      if (v.ownerPlays && !v.ownerAck) throw new Error('Tick the box to say you are happy to see your own Santa - or untick "I\'m playing".');
      const r = await api.post('/api/manage/teams', v);
      return r.id;
    },
  });
  if (typeof id === 'number') {
    toast('Game created! 🎉 Now invite your players.', 'ok');
    location.hash = `#/manage/${id}`;
  }
}

const DAYS = (n) => (Number(n) === 0 ? 'on the day' : `${plural(Number(n), 'day')} before`);

function remindersList(d, kind) {
  const rows = d.reminders.filter((r) => r.kind === kind);
  const plan = d.team.reminderDays
    ? html`<p class="muted" style="margin:10px 0 0">Automatic reminders: ${d.team.reminderDays.split(',').map(DAYS).join(', ')} ${kind === 'location' ? 'check-in closes' : 'the game ends'}${kind === 'location' && !d.checkIn.deadline ? ' (set a check-in date to use them)' : ''}.</p>`
    : html`<p class="muted" style="margin:10px 0 0">Automatic reminders are off for this team (Settings › Gentle reminder days).</p>`;
  if (!rows.length) return plan;
  return html`${plan}<ul class="list" style="margin-top:6px">${rows.map((r) => html`<li><span class="emoji">📨</span><div class="grow">${r.manual ? 'Sent by hand' : `Automatic, ${DAYS(r.offset)}`}
    <div class="meta">${fmtDateTime(r.sentAt)} · ${plural(r.recipients, 'email')}</div></div></li>`)}</ul>`;
}

function nudgeButton(d, kind, label) {
  const a = d.audience[kind];
  const quiet = a.total - a.reachable;
  return html`<div class="row"><button class="btn small" data-act="nudge" data-kind="${kind}" ${a.reachable ? '' : 'disabled'}>💌 ${label} (${a.reachable})</button>
    ${quiet ? html`<span class="muted">${quiet} on Do not disturb or without email - they'll see it in the app</span>` : ''}</div>`;
}

function poolCard(p, d, locations) {
  const max = Math.max(...d.pools.map((x) => x.count), 1);
  const canMerge = d.team.phase === 'setup' && d.team.matchScope === 'location';
  return html`
    <div class="pool ${p.level}">
      <div class="head"><span class="name">${p.level === 'error' ? '⛔' : p.level === 'warn' ? '⚠️' : '✅'} ${p.label}</span><span class="n">${p.count}</span></div>
      <div class="bar"><i style="width:${Math.round((p.count / max) * 100)}%"></i></div>
      ${p.merged ? html`<div class="from">Includes: ${p.from.map((f) => `${f.name} (${f.count})`).join(', ')}</div>` : ''}
      ${p.issues.length ? html`<div class="issues">${p.issues.join(' ')}</div>` : html`<div class="issues muted">Ready to draw.</div>`}
      ${canMerge && p.key !== 'none' && p.level !== 'ok' ? html`
        <div class="inline-form" style="margin-top:8px">
          <div class="field" style="min-width:120px"><label class="sr-only" for="m-${p.key}">Merge into</label>
            <select id="m-${p.key}" data-merge-target="${p.key}">${locations.filter((l) => l.id !== p.locationId).map((l) => html`<option value="${l.id}">match with ${l.name}</option>`)}</select></div>
          <button class="btn small" data-act="merge" data-pool="${p.key}">Merge</button></div>` : ''}
      ${canMerge && p.key === 'none' ? html`<p class="muted" style="margin:6px 0 0">Set their location in the list below.</p>` : ''}
    </div>`;
}

function membersTab(d, locations) {
  const drawn = d.team.phase !== 'setup';
  const errors = d.pools.filter((p) => p.level === 'error').length;
  const adjusted = d.members.some((m) => m.poolLocationId);
  const poolName = new Map(d.pools.map((p) => [p.key, p.label]));
  const ci = d.checkIn;
  const playing = d.members.filter((m) => !m.optedOut).length;
  const link = `${location.origin}/#/join/${d.team.inviteCode}`;
  return html`
    <div class="grid two" style="margin-bottom:var(--gap)">
      <div class="card">
        <div class="card-title"><h2>🎟️ Invite players</h2><span class="spacer"></span><span class="code-pill" title="Invite code">${d.team.inviteCode}</span></div>
        <p class="muted">Share this link (or the code). Anyone signed in can join until names are drawn${d.team.joinOpen ? ' - and the game is also listed on everyone\'s home page' : ''}.</p>
        <div class="invite-box"><input id="invite-link" readonly value="${link}" aria-label="Invite link"><button class="btn small" data-act="copy-link">📋 Copy</button></div>
        <div class="row" style="margin-top:10px"><button class="btn ghost small" data-act="add-members">➕ Add people yourself</button>
          <button class="btn link small" data-act="new-code">New code (the old link stops working)</button></div>
      </div>
      <div class="card">
        <div class="card-title"><h2>🎅 You, the organiser</h2></div>
        ${d.team.ownerPlays
    ? html`<p>You're <b>playing</b> in this game too.${d.team.ownerAccepted ? ' You accepted that you can see the whole Santa list, your own Santa included.' : ''}</p>
              <button class="btn ghost small" data-act="owner-leave">Stop playing (keep organising)</button>`
    : html`<p class="muted">You organise this game but you're not playing in it. You can join any time before names are drawn.</p>
              <button class="btn small" data-act="owner-play">🎄 I want to play too</button>`}
      </div>
    </div>
    ${drawn ? '' : html`<div class="card" style="margin-bottom:var(--gap)">
      <div class="card-title"><h2>📍 Phase 1: check-in</h2><span class="spacer"></span>
        <span class="badge ${ci.total && ci.confirmed === ci.total ? 'ok' : 'gold'}">${ci.confirmed} of ${ci.total} checked in</span>
        ${d.sittingOut.length ? html`<span class="badge">🛋️ ${d.sittingOut.length} sitting out</span>` : ''}</div>
      <p class="muted">${ci.deadline
    ? (ci.open ? `Players confirm where they play from (or choose to sit out) until ${fmtDate(ci.deadline)}.` : `Check-in closed on ${fmtDate(ci.deadline)}. Anyone who didn't check in is drawn from their profile location - or set it for them below.`)
    : 'No check-in date - players can confirm their location until you draw names. Set one under Settings to send automatic reminders.'}</p>
      ${nudgeButton(d, 'location', 'Send a gentle check-in nudge now')}
      ${remindersList(d, 'location')}
    </div>`}
    <div class="card">
      <div class="card-title"><h2>📍 Location balance</h2><span class="spacer"></span>
        ${d.team.matchScope === 'location' && !drawn ? html`<button class="btn ghost small" data-act="scope-all">Match everyone together instead</button>` : ''}
        ${d.team.matchScope === 'all' && !drawn ? html`<button class="btn ghost small" data-act="scope-loc">Match within locations</button>` : ''}
        ${adjusted && !drawn ? html`<button class="btn ghost small" data-act="reset-pools">↺ Undo merges</button>` : ''}</div>
      <p class="muted">${d.team.matchScope === 'all' ? 'Everyone in this team is drawn together, wherever they play from.'
    : 'Names are drawn separately in each location. A location with one person cannot be matched, and very small ones make it easy to guess your Santa - merge them into another location for this team.'}
        Odd numbers are fine: each group is drawn as one circle.</p>
      ${errors ? html`<div class="alert error"><span class="ico">⛔</span><div>${plural(errors, 'group needs', 'groups need')} fixing before names can be drawn.</div></div>` : ''}
      ${d.pools.length ? html`<div class="pools">${d.pools.map((p) => poolCard(p, d, locations))}</div>` : html`<p class="muted">Add players to see the balance.</p>`}
    </div>
    <div class="section-title"><h2>👥 Players <span class="muted" style="font-size:1rem">(${playing}${d.sittingOut.length ? ` + ${d.sittingOut.length} sitting out` : ''})</span></h2>
      <button class="btn red" data-act="add-members">+ Add players</button></div>
    ${d.unmatched.length ? html`<div class="alert warn"><span class="ico">🆕</span><div>${plural(d.unmatched.length, 'player joined', 'players joined')} after the draw and ${d.unmatched.length === 1 ? 'is' : 'are'} not in the circle yet. Use <b>Insert</b> to slot them in without redrawing everyone - only one Santa's child changes.</div></div>` : ''}
    ${d.members.length ? html`<div class="table-wrap"><table class="table stack">
      <thead><tr><th>Player</th><th>Plays from</th><th>Drawn with</th>${drawn ? '' : html`<th>Check-in</th>`}<th>Wishlist</th>${drawn ? html`<th>Circle</th>` : ''}<th></th></tr></thead>
      <tbody>${d.members.map((m) => html`<tr class="${m.optedOut ? 'row-out' : ''}">
        <td class="first"><div class="row" style="flex-wrap:nowrap">${avatar(m.name, { cls: 'tiny' })}<div><b>${m.name}</b>
          ${m.dnd ? html` <span class="badge" title="Do not disturb - no emails">🔕</span>` : ''}
          ${m.optedOut ? html` <span class="badge">🛋️ sitting out</span>` : ''}
          <div class="muted" style="font-size:.8rem">${m.email || ''}${m.externalId ? ` · ${m.externalId}` : ''}</div></div></div></td>
        <td data-label="Plays from">${m.locationName || html`<span class="badge error">not set</span>`}${m.teamLocationId ? html` <span class="badge" title="Chosen for this team">this team</span>` : ''}</td>
        <td data-label="Drawn with">${poolName.get(m.pool) || ''}${m.poolLocationId ? html` <span class="badge gold">merged</span>` : ''}</td>
        ${drawn ? '' : html`<td data-label="Check-in">${m.optedOut ? '' : m.confirmedAt ? html`<span class="badge ok" title="${fmtDateTime(m.confirmedAt)}">✓ checked in</span>` : html`<span class="badge gold">not yet</span>`}</td>`}
        <td data-label="Wishlist">${m.hasWishlist ? '✅' : html`<span class="muted">empty</span>`}</td>
        ${drawn ? html`<td data-label="Circle">${m.inCircle ? html`<span class="badge ok">in</span>` : m.optedOut ? html`<span class="muted">-</span>` : html`<button class="btn small gold" data-act="insert" data-id="${m.id}">Insert</button>`}</td>` : ''}
        <td class="nowrap">${!m.inCircle && !m.optedOut ? html`<button class="btn link small" data-act="member-loc" data-id="${m.id}">Location</button>` : ''}
          ${!m.inCircle ? html`<button class="btn link small" data-act="sit-toggle" data-id="${m.id}" data-out="${m.optedOut ? '0' : '1'}">${m.optedOut ? 'Bring back' : 'Sit out'}</button>` : ''}
          <button class="btn danger-link small" data-act="remove" data-id="${m.id}">Remove</button></td></tr>`)}</tbody></table></div>`
    : html`<div class="card empty"><span class="big-emoji">🧑‍🎄</span>No players yet.</div>`}`;
}

function exclusionsTab(d) {
  return html`
    <div class="grid side">
      <div class="card">
        <h2>🚫 Never match these pairs</h2>
        <p class="muted">Partners, a manager and their report, last year's pair... Neither person in a pair will draw the other.</p>
        ${d.exclusions.length ? html`<ul class="list">${d.exclusions.map((e) => html`<li><span class="emoji">🚫</span><div class="grow"><b>${e.aName}</b> ↔ <b>${e.bName}</b></div>
          <button class="btn danger-link small" data-act="del-excl" data-a="${e.a}" data-b="${e.b}">Remove</button></li>`)}</ul>`
    : html`<div class="empty">No exclusions.</div>`}
      </div>
      <form class="card" id="excl" novalidate>
        <h3>+ Add a pair</h3>
        <div class="field"><label for="ea">Person</label><select id="ea" name="a">${d.members.map((m) => html`<option value="${m.id}">${m.name}</option>`)}</select></div>
        <div class="field"><label for="eb">should never draw (or be drawn by)</label><select id="eb" name="b">${d.members.map((m, i) => html`<option value="${m.id}" ${i === 1 ? 'selected' : ''}>${m.name}</option>`)}</select></div>
        <button class="btn" type="submit" ${d.members.length < 2 ? 'disabled' : ''}>Add</button>
      </form>
    </div>`;
}

function drawTab(d, matches) {
  const t = d.team;
  const errors = d.pools.filter((p) => p.level === 'error');
  const warns = d.pools.filter((p) => p.level === 'warn');
  if (t.phase === 'setup') {
    return html`
      <div class="card" style="max-width:760px">
        <h2>🎟️ Draw names</h2>
        <ul class="list">
          <li><span class="emoji">${d.members.filter((m) => !m.optedOut).length >= 2 ? '✅' : '⛔'}</span><div class="grow">${plural(d.members.filter((m) => !m.optedOut).length, 'player')} playing${d.sittingOut.length ? ` (${d.sittingOut.length} sitting out)` : ''}</div></li>
          <li><span class="emoji">${d.checkIn.confirmed === d.checkIn.total ? '✅' : '📍'}</span><div class="grow">${d.checkIn.confirmed} of ${d.checkIn.total} checked in${d.checkIn.deadline ? ` - check-in ${d.checkIn.open ? 'closes' : 'closed'} ${fmtDate(d.checkIn.deadline)}` : ''}${d.checkIn.confirmed < d.checkIn.total ? ' (the rest are drawn from their profile location)' : ''}</div></li>
          <li><span class="emoji">${errors.length ? '⛔' : '✅'}</span><div class="grow">${errors.length ? html`<b>Fix first:</b> ${errors.map((p) => `${p.label} (${p.issues.join(' ')})`).join(' · ')} <a href="#/manage/${t.id}/members">Go to locations →</a>` : 'Every location can be matched'}</div></li>
          ${warns.length ? html`<li><span class="emoji">⚠️</span><div class="grow">Small groups (allowed, but easy to guess): ${warns.map((p) => `${p.label} (${p.count})`).join(', ')}</div></li>` : ''}
          <li><span class="emoji">🚫</span><div class="grow">${plural(d.exclusions.length, 'exclusion')}</div></li>
          <li><span class="emoji">📅</span><div class="grow">Plays ${fmtDate(t.startDate)} - ${fmtDate(t.endDate)}</div></li>
        </ul>
        <button class="btn red big" data-act="draw" ${errors.length || d.members.filter((m) => !m.optedOut).length < 2 ? 'disabled' : ''}>🎩 Draw names</button>
      </div>`;
  }
  return html`
    <div class="grid two">
      <div class="card">
        <h2>🎟️ Names are drawn</h2>
        <p>${plural(d.members.length - d.unmatched.length, 'player')} in the circle${d.unmatched.length ? html`, <b>${d.unmatched.length} waiting to be inserted</b>` : ''}. Drawn ${t.drawCount > 1 ? `${t.drawCount} times` : 'once'}.</p>
        <p class="muted">So far: ${plural(d.activity.gifts, 'gift')} (${d.stats.finals} final, ${d.stats.received} received), ${plural(d.activity.tasks, 'task')} (${d.stats.tasksDone} done), ${plural(d.activity.messages, 'note')}.</p>
        <h3>📣 Email the team</h3>
        <div class="row">
          <button class="btn small" data-act="notify" data-kind="matched">🎅 Remind every Santa of their child</button>
          <button class="btn small ghost" data-act="notify" data-kind="reminder">⏰ Wishlist reminder</button>
          <button class="btn small ghost" data-act="notify" data-kind="start">🎄 "Game on!"</button>
        </div>
        <h3 style="margin-top:18px">🎁 Phase 2: gentle gift reminders</h3>
        <p class="muted">A soft, no-pressure jingle to Santas who haven't logged a final gift yet. ${d.audience.gift.total ? '' : 'Every Santa has logged a final gift - nothing to send! 🎉'}</p>
        ${t.phase === 'live' ? nudgeButton(d, 'gift', 'Send a friendly jingle now') : html`<p class="muted">Available while the game is on (${fmtDate(t.startDate)} - ${fmtDate(t.endDate)}).</p>`}
        ${remindersList(d, 'gift')}
        <h3 style="margin-top:18px">🎉 The reveal</h3>
        <p class="muted">${t.revealed ? 'Players can see who their Santa was.' : t.revealMode === 'after_end' ? `Santas are revealed automatically after ${fmtDate(t.endDate)}.` : 'Santas stay secret until you reveal them.'}</p>
        <div class="row">${t.revealedFlag ? html`<button class="btn ghost small" data-act="hide">🙈 Hide the Santas again</button>`
    : html`<button class="btn gold small" data-act="reveal">🎉 Reveal the Santas now</button>`}</div>
        <hr>
        <h3>⚠️ Start over</h3>
        <div class="row"><button class="btn ghost small" data-act="draw">🎩 Redraw everyone</button><button class="btn danger-link small" data-act="undraw">Undo the draw</button></div>
        <p class="muted">Both erase the ${plural(d.activity.total, 'gift, task and note', 'gifts, tasks and notes')} logged so far.</p>
      </div>
      <div class="card ${matches && matches.open ? 'unsealed' : ''}">
        <div class="card-title"><h2>✉️ The Santa list</h2><span class="spacer"></span>
          ${matches ? html`<button class="btn ghost small" data-act="seal">${matches.open ? '🙈 Seal' : '👀 Unseal'}</button>` : ''}</div>
        ${d.team.ownerPlays ? html`<div class="alert gold"><span class="ico">🙈</span><div>You play in this game, so this list includes <b>your own Santa</b>. Peek only if you need to.</div></div>` : ''}
        ${matches ? html`
          <p class="muted">Blurred so you don't spoil it for yourself. Every look is written to the audit log.</p>
          <div class="table-wrap"><table class="table stack"><thead><tr><th>Santa 🎁→ child</th><th class="num">Gifts</th><th class="num">Tasks</th></tr></thead>
            <tbody>${matches.rows.map((r) => html`<tr><td class="first"><span class="sealed">${r.santa}</span> 🎁→ <span class="sealed">${r.child}</span></td><td data-label="Gifts" class="num">${r.gifts}${r.final ? ' 🏆' : ''}</td><td data-label="Tasks" class="num">${r.tasks}</td></tr>`)}</tbody></table></div>`
    : html`<p class="muted">Who is whose Santa is a secret - even from you, unless you choose to look. Looking is recorded in the audit log.</p>
          <button class="btn ghost" data-act="load-matches">👀 Show the Santa list</button>`}
      </div>
    </div>`;
}

function settingsTab(d) {
  const t = d.team;
  return html`
    <form class="card" id="team-form" novalidate style="max-width:820px">
      <h2>⚙️ Game settings</h2>
      ${teamForm(t)}
      <div class="alert error" data-err hidden></div>
      <div class="form-actions"><button class="btn" type="submit">Save</button></div>
    </form>
    <div class="card" style="max-width:820px;margin-top:18px">
      <h3>🗑️ Delete this game</h3>
      <p class="muted">Removes the game, its draw, gifts, tasks and notes. People and their wishlists stay.</p>
      <button class="btn red" data-act="delete-team">Delete ${t.name}</button>
    </div>`;
}

export async function manageView(main, { params, isCurrent }) {
  const id = params.id;
  const base = `/api/manage/teams/${id}`;
  let [d, locations] = await Promise.all([api.get(base), api.get('/api/locations')]);
  if (!isCurrent()) return;
  const tab = params.tab || 'members';
  let matches = null;

  const draw = () => {
    const t = d.team;
    const tabs = [['members', '👥 Players & locations'], ['exclusions', `🚫 Exclusions${d.exclusions.length ? ` (${d.exclusions.length})` : ''}`], ['draw', t.phase === 'setup' ? '🎩 Draw names' : '🎟️ The draw'], ['settings', '⚙️ Settings']];
    let body;
    if (tab === 'exclusions') body = exclusionsTab(d);
    else if (tab === 'draw') body = drawTab(d, matches);
    else if (tab === 'settings') body = settingsTab(d);
    else body = membersTab(d, locations);
    mount(main, html`
      <p style="margin:0 0 6px"><a href="#/">← My games</a>${t.ownerPlays ? html` · <a href="#/team/${id}">See it as a player</a>` : ''}</p>
      <div class="page-head">
        <div><h1>${t.name}</h1><p class="sub">📅 ${fmtShort(t.startDate)} - ${fmtDate(t.endDate)} · ${t.matchScope === 'all' ? 'everyone together' : 'by location'}${t.budget ? ` · 💰 ${t.budget}` : ''}</p></div>
        <div class="row"><span class="badge gold">🧝 you organise this</span>${phaseBadge(t.phase)}${t.revealed ? html`<span class="badge gold">revealed</span>` : ''}${t.joinOpen ? html`<span class="badge blue">open sign-up</span>` : ''}</div>
      </div>
      ${d.warnings.length ? html`<div class="stack" style="gap:8px;margin-bottom:14px">${d.warnings.map((w) => html`<div class="alert ${w.level === 'info' ? 'info' : 'warn'}" style="margin:0"><span class="ico">⚠️</span><div>${w.text.replace(`${t.name}: `, '')}</div></div>`)}</div>` : ''}
      <nav class="tabs">${tabs.map(([k, l]) => html`<a href="#/manage/${id}/${k}" class="${k === tab ? 'active' : ''}">${l}</a>`)}</nav>
      ${body}`);
    bindForms();
  };

  function bindForms() {
    const ex = main.querySelector('#excl');
    if (ex) {
      ex.addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
          d = await api.post(`${base}/exclusions`, { a: ex.a.value, b: ex.b.value });
          if (d.notice) toast(d.notice, 'error');
          draw();
        } catch (err) { toast(errorText(err), 'error'); }
      });
    }
    const tf = main.querySelector('#team-form');
    if (tf) {
      tf.addEventListener('submit', async (e) => {
        e.preventDefault();
        const err = tf.querySelector('[data-err]');
        err.hidden = true;
        try {
          const v = Object.fromEntries([...tf.elements].filter((el) => el.name).map((el) => [el.name, el.type === 'checkbox' ? el.checked : el.value]));
          d = await api.put(base, v);
          toast('Saved', 'ok');
          draw();
        } catch (ex2) { err.textContent = errorText(ex2); err.hidden = false; }
      });
    }
  }

  const member = (uid) => d.members.find((m) => String(m.id) === String(uid));
  const saveTeam = (patch) => api.put(base, {
    name: d.team.name, description: d.team.description, startDate: d.team.startDate, endDate: d.team.endDate, budget: d.team.budget,
    matchScope: d.team.matchScope, minGroupSize: d.team.minGroupSize, revealMode: d.team.revealMode, joinOpen: d.team.joinOpen, ...patch,
  });

  actions(main, {
    'copy-link': async () => {
      const input = main.querySelector('#invite-link');
      try {
        await navigator.clipboard.writeText(input.value);
      } catch {
        input.select();
        document.execCommand('copy');
      }
      toast('Invite link copied - paste it into your team chat 🎟️', 'ok');
    },
    'new-code': async () => {
      if (!await confirmBox('Make a new invite code?', { ok: 'New code', detail: 'The old link stops working. People already in the game stay in.' })) return;
      d = await api.post(`${base}/invite/reset`);
      draw();
    },
    'owner-play': async () => {
      const out = await formModal({
        title: '🎄 Play in your own game',
        submit: 'Count me in',
        body: html`<p>As the organiser you can open the Santa list - so you can see who <b>your</b> Santa is. Some organisers prefer not to play for exactly that reason, and that's fine too!</p>
          ${d.team.ownerAccepted ? '' : html`<label class="check"><input type="checkbox" name="ownerAck" required><span>${OWNER_ACK}</span></label>`}`,
        onSubmit: (v) => api.post(`${base}/play`, { play: true, ownerAck: v.ownerAck }),
      });
      if (out && out.team) { d = out; toast("You're in! 🎅", 'ok'); draw(); }
    },
    'owner-leave': async () => {
      const drawnNow = d.team.phase !== 'setup';
      if (!await confirmBox('Stop playing in your own game?', { ok: 'Stop playing', detail: drawnNow ? 'Your Santa takes over your child, so the circle stays whole.' : 'You keep organising it.' })) return;
      d = await api.post(`${base}/play`, { play: false });
      draw();
    },
    merge: async (ds) => {
      const target = main.querySelector(`[data-merge-target="${ds.pool}"]`).value;
      d = await api.post(`${base}/pools/merge`, { fromPool: ds.pool, intoLocationId: target });
      toast('Merged for this team 🤝', 'ok');
      draw();
    },
    'reset-pools': async () => { d = await api.post(`${base}/pools/reset`); draw(); },
    'scope-all': async () => { d = await saveTeam({ matchScope: 'all' }); draw(); },
    'scope-loc': async () => { d = await saveTeam({ matchScope: 'location' }); draw(); },
    'add-members': async () => {
      const active = (await api.get(`/api/directory?notInTeam=${id}`)).map((u) => ({ ...u, locationName: u.location }));
      const out = await formModal({
        title: '➕ Add players',
        submit: 'Add selected',
        wide: true,
        body: html`
          ${active.length ? html`
            <div class="row" style="margin-bottom:10px">
              <input type="search" id="pick-q" placeholder="Filter by name, email or location" style="flex:1">
              <button class="btn ghost small" type="button" data-pick-all>Select shown</button>
            </div>
            <div class="row" style="margin-bottom:10px">${locations.map((l) => html`<button class="btn ghost small" type="button" data-pick-loc="${l.name}">All from ${l.name}</button>`)}</div>
            <div class="persona-list" style="max-height:340px">${active.map((u) => html`
              <label class="persona" data-search="${`${u.name} ${u.email} ${u.locationName || ''}`.toLowerCase()}" data-loc="${u.locationName || ''}">
                <input type="checkbox" name="u${u.id}" value="${u.id}" ${u.me ? 'data-me' : ''}> ${avatar(u.name)}
                <span><b>${u.name}</b>${u.me ? html` <span class="badge gold">you</span>` : ''}<span class="meta">${u.email} · ${u.locationName || 'no location'}</span></span></label>`)}</div>`
    : html`<p class="muted">Everyone is already in this game. Share the invite link with anyone else.</p>`}
          <label class="check" data-ack hidden style="margin-top:12px"><input type="checkbox" name="ownerAck"><span>${OWNER_ACK}</span></label>`,
        onOpen: (dlg) => {
          const q = dlg.querySelector('#pick-q');
          if (!q) return;
          const me = dlg.querySelector('[data-me]');
          if (me && !d.team.ownerAccepted) me.addEventListener('change', () => { dlg.querySelector('[data-ack]').hidden = !me.checked; });
          q.addEventListener('input', () => {
            const s = q.value.toLowerCase();
            for (const row of dlg.querySelectorAll('[data-search]')) row.hidden = !row.dataset.search.includes(s);
          });
          dlg.addEventListener('click', (e) => {
            const all = e.target.closest('[data-pick-all]');
            const loc = e.target.closest('[data-pick-loc]');
            for (const row of dlg.querySelectorAll('[data-search]')) {
              if (all && !row.hidden) row.querySelector('input').checked = true;
              if (loc && row.dataset.loc === loc.dataset.pickLoc) row.querySelector('input').checked = true;
            }
          });
        },
        onSubmit: (v) => {
          const userIds = Object.entries(v).filter(([k, val]) => k.startsWith('u') && val === true).map(([k]) => Number(k.slice(1)));
          if (!userIds.length) throw new Error('Pick at least one person');
          return api.post(`${base}/members`, { userIds, ownerAck: v.ownerAck });
        },
      });
      if (out && out.detail) { d = out.detail; toast(`${plural(out.added, 'player')} added 🎉`, 'ok'); draw(); }
    },
    'member-loc': async (ds) => {
      const m = member(ds.id);
      const out = await formModal({
        title: `📍 ${m.name}`,
        body: html`
          <div class="field"><label for="ml">Plays from (in this team)</label><select id="ml" name="locationId"><option value="">Their profile location</option>
            ${locations.map((l) => html`<option value="${l.id}" ${m.teamLocationId === l.id ? 'selected' : ''}>${l.name}</option>`)}</select></div>
          <div class="field"><label for="mp">Drawn together with</label><select id="mp" name="poolLocationId"><option value="">Their own location</option>
            ${locations.map((l) => html`<option value="${l.id}" ${m.poolLocationId === l.id ? 'selected' : ''}>${l.name}</option>`)}</select>
            <div class="hint">Use this to move one person into another location's draw.</div></div>`,
        onSubmit: (v) => api.put(`${base}/members/${m.id}`, { locationId: v.locationId || null, poolLocationId: v.poolLocationId || null }),
      });
      if (out && out.team) { d = out; draw(); }
    },
    remove: async (ds) => {
      const m = member(ds.id);
      const drawn = d.team.phase !== 'setup' && m.inCircle;
      if (!await confirmBox(`Remove ${m.name} from ${d.team.name}?`, {
        ok: 'Remove',
        danger: true,
        detail: drawn ? `Their Santa takes over their child, so the circle stays whole (that Santa gets an email about their new child).` : '',
      })) return;
      const r = await api.del(`${base}/members/${m.id}`);
      d = r.detail;
      for (const n of r.notes) toast(n, 'error');
      draw();
    },
    'sit-toggle': async (ds) => {
      const m = member(ds.id);
      const out = ds.out === '1';
      if (out && !await confirmBox(`Mark ${m.name} as sitting this game out?`, { ok: 'Sit out', detail: 'They stay in the list but are not drawn and get no emails about this game. They can count themselves back in before the draw.' })) return;
      d = await api.put(`${base}/members/${m.id}`, { optedOut: out });
      toast(out ? `${m.name} is sitting this one out 🛋️` : `${m.name} is back in 🎄`, 'ok');
      draw();
    },
    nudge: async (ds) => {
      const a = d.audience[ds.kind];
      const what = ds.kind === 'location' ? 'a gentle check-in nudge' : 'a friendly gift jingle';
      if (!await confirmBox(`Send ${what} to ${plural(a.reachable, 'person', 'people')}?`, { ok: 'Send', detail: 'Soft and fun, with a Do-not-disturb link at the bottom. People on Do not disturb are skipped.' })) return;
      const r = await api.post(`${base}/remind`, { kind: ds.kind });
      d = r.detail;
      toast(`${plural(r.mailed, 'email')} on the way 💌`, 'ok');
      draw();
    },
    insert: async (ds) => {
      const m = member(ds.id);
      const out = await formModal({
        title: `🆕 Insert ${m.name} into the circle`,
        submit: 'Insert',
        body: html`<p>A random Santa in ${m.locationName || 'their group'} gets ${m.name} as their new child, and ${m.name} takes over that Santa's old child. Nobody else changes.</p>
          <label class="check"><input type="checkbox" name="notify" checked> Email both of them their (new) child</label>`,
        onSubmit: (v) => api.post(`${base}/members/${m.id}/insert`, v),
      });
      if (out && out.team) { d = out; matches = null; toast(`${m.name} is in the circle 🎉`, 'ok'); draw(); }
    },
    'del-excl': async (ds) => { d = await api.del(`${base}/exclusions/${ds.a}/${ds.b}`); draw(); },
    draw: async () => {
      const redraw = d.team.phase !== 'setup';
      const out = await formModal({
        title: redraw ? '🎩 Redraw everyone?' : '🎩 Draw names',
        submit: redraw ? 'Redraw' : 'Draw names',
        danger: redraw,
        body: html`
          ${redraw ? html`<div class="alert error"><span class="ico">⚠️</span><div>Everybody gets a new child, and the ${plural(d.activity.total, 'gift, task and note', 'gifts, tasks and notes')} logged so far are erased.</div></div>` : ''}
          <p>${plural(d.members.length, 'player')} will be matched ${d.team.matchScope === 'all' ? 'all together' : `within ${plural(d.pools.length, 'group')}`}, respecting ${plural(d.exclusions.length, 'exclusion')}.</p>
          <label class="check"><input type="checkbox" name="notify" checked> Email every Santa who their child is</label>`,
        onSubmit: (v) => api.post(`${base}/draw`, { notify: v.notify, redraw }),
      });
      if (out && out.team) {
        d = out;
        matches = null;
        toast(`Names drawn! 🎉 ${out.mailed ? `${plural(out.mailed, 'email')} on the way.` : ''}`, 'ok');
        draw();
      }
    },
    undraw: async () => {
      if (!await confirmBox('Undo the draw?', { ok: 'Undo draw', danger: true, detail: `Nobody will have a child, and ${plural(d.activity.total, 'logged item')} (gifts, tasks, notes) are erased.` })) return;
      d = await api.post(`${base}/undraw`);
      matches = null;
      draw();
    },
    'load-matches': async () => {
      matches = { rows: await api.get(`${base}/matches`), open: false };
      draw();
    },
    seal: () => { matches.open = !matches.open; draw(); },
    notify: async (ds) => {
      const labels = { matched: 'remind every Santa who their child is', reminder: 'send everyone a wishlist reminder', start: 'tell everyone the game is on' };
      if (!await confirmBox(`Email the team to ${labels[ds.kind]}?`, { ok: 'Send' })) return;
      const r = await api.post(`${base}/notify`, { kind: ds.kind });
      toast(`${plural(r.mailed, 'email')} queued ✉️`, 'ok');
    },
    reveal: async () => {
      const out = await formModal({
        title: '🎉 Reveal the Santas',
        submit: 'Reveal',
        body: html`<p>Every player will see who their Secret Santa was.</p><label class="check"><input type="checkbox" name="notify" checked> Send everyone the reveal email</label>`,
        onSubmit: (v) => api.post(`${base}/reveal`, { revealed: true, notify: v.notify }),
      });
      if (out && out.team) { d = out; draw(); toast('The masks are off! 🎉', 'ok'); }
    },
    hide: async () => { d = await api.post(`${base}/reveal`, { revealed: false }); draw(); },
    'delete-team': async () => {
      if (!await confirmBox(`Delete ${d.team.name}?`, { ok: 'Delete team', danger: true, detail: 'This cannot be undone.' })) return;
      await api.del(base);
      toast('Game deleted');
      location.hash = '#/';
    },
  });

  draw();
}
