// Joining a game with an invite code or link - from the home page's "Join a
// game", or by opening a shared link (#/join/<code>).
import { api, html, mount, toast, formModal, fmtDate, fmtShort, plural, errorText, phaseBadge, formValues } from '../lib.js';

const ACK = html`<label class="check" style="margin-top:12px"><input type="checkbox" name="ownerAck">
  <span><b>I understand</b> that as the organiser I can see the whole Santa list - including who my own Santa is. 🙈</span></label>`;

function previewBody(p, locations) {
  const t = p.team;
  return html`
    <div class="gift-tag" style="margin-bottom:14px">
      <div class="label">You're invited to</div>
      <div class="value">${t.name}</div>
      <div class="sub">${t.organiser ? `organised by ${t.organiser} · ` : ''}${plural(t.memberCount, 'player')} so far</div>
    </div>
    ${t.description ? html`<p style="white-space:pre-line">${t.description}</p>` : ''}
    <div class="hints" style="margin-bottom:14px">
      <div class="hint-box"><div class="k">🎁 Game on</div><div class="v">${fmtShort(t.startDate)} - ${fmtDate(t.endDate)}</div></div>
      ${t.locationDeadline ? html`<div class="hint-box"><div class="k">📍 Check in by</div><div class="v">${fmtDate(t.locationDeadline)}</div></div>` : ''}
      ${t.budget ? html`<div class="hint-box"><div class="k">💰 Budget</div><div class="v">${t.budget}</div></div>` : ''}
    </div>
    ${p.canJoin ? html`
      <div class="field"><label for="jloc">Where will you play from?</label>
        <select id="jloc" name="locationId"><option value="">My usual location</option>
          ${locations.map((l) => html`<option value="${l.id}">${l.name}</option>`)}</select>
        <div class="hint">You're matched with people in the same place.</div></div>
      ${p.isOwner && !p.ownerAccepted ? ACK : ''}` : ''}`;
}

// code -> preview -> join -> the game's page
export async function joinFlow(code) {
  const [p, locations] = await Promise.all([api.get(`/api/join/${encodeURIComponent(code)}`), api.get('/api/locations')]);
  if (p.alreadyIn) {
    toast(`You're already in ${p.team.name} 🎄`);
    location.hash = `#/team/${p.team.id}`;
    return;
  }
  if (!p.canJoin) {
    toast(p.reason || 'This game cannot be joined right now', 'error');
    return;
  }
  const out = await formModal({
    title: '🎟️ Join a game',
    submit: 'Count me in!',
    body: previewBody(p, locations),
    onSubmit: (v) => api.post(`/api/join/${encodeURIComponent(code)}`, { locationId: v.locationId || null, ownerAck: v.ownerAck }),
  });
  if (out && out.id) {
    toast(`Welcome to ${p.team.name}! 🎉`, 'ok');
    location.hash = `#/team/${out.id}/team`;
  }
}

export function askForCode() {
  return formModal({
    title: '🎟️ Join a game',
    submit: 'Find the game',
    body: html`
      <p>Got an invite from an organiser? Paste the code or the whole link.</p>
      <div class="field"><label for="jcode">Invite code or link</label>
        <input id="jcode" name="code" required autocomplete="off" spellcheck="false" placeholder="e.g. reindeer26" autofocus></div>`,
    onSubmit: async (v) => {
      const code = String(v.code || '').trim();
      if (!code) throw new Error('Paste the invite code or link');
      await api.get(`/api/join/${encodeURIComponent(code)}`);
      return code;
    },
  }).then((code) => (typeof code === 'string' ? joinFlow(code) : null));
}

// #/join/<code>: an invite link someone shared
export async function joinView(main, { params, isCurrent }) {
  let p;
  let locations;
  try {
    [p, locations] = await Promise.all([api.get(`/api/join/${encodeURIComponent(params.code)}`), api.get('/api/locations')]);
  } catch (err) {
    if (!isCurrent()) return;
    mount(main, html`<div class="card empty" style="max-width:560px;margin:0 auto"><span class="big-emoji">🦌</span><h2>That invite didn't work</h2>
      <p>${errorText(err)}</p><a class="btn" href="#/">Back to my games</a></div>`);
    return;
  }
  if (!isCurrent()) return;
  if (p.alreadyIn) {
    location.replace(`#/team/${p.team.id}`);
    return;
  }
  mount(main, html`
    <form id="join" class="card ribbon" style="max-width:620px;margin:0 auto" novalidate><div class="card-body">
      <div class="row between" style="margin-bottom:10px"><h2 style="margin:0">🎟️ You're invited!</h2>${phaseBadge(p.team.phase)}</div>
      ${previewBody(p, locations)}
      ${p.canJoin ? '' : html`<div class="alert warn"><span class="ico">⏳</span><div>${p.reason}</div></div>`}
      <div class="alert error" data-err hidden></div>
      <div class="form-actions"><a class="btn ghost" href="#/">Not now</a>${p.canJoin ? html`<button class="btn red" type="submit">🙋 Count me in!</button>` : ''}</div>
    </div></form>`);
  const form = main.querySelector('#join');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = form.querySelector('[data-err]');
    err.hidden = true;
    try {
      const v = formValues(form);
      const out = await api.post(`/api/join/${encodeURIComponent(params.code)}`, { locationId: v.locationId || null, ownerAck: v.ownerAck });
      toast(`Welcome to ${p.team.name}! 🎉`, 'ok');
      location.hash = `#/team/${out.id}/team`;
    } catch (ex) {
      err.textContent = errorText(ex);
      err.hidden = false;
    }
  });
}
