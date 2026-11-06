'use strict';
// Turns game events into queued emails, honouring the admin's notification
// switches, each person's Do Not Disturb, and who is sitting a game out.
// Never throws into the request that triggered it: a mail problem must not
// undo a gift that was just logged.
const emails = require('./emails');
const T = require('./teams');
const { today, addDays } = require('../lib/util');

function create(app) {
  const { db } = app;

  const ctx = () => {
    const general = app.settings.read('general');
    const base = app.publicUrl();
    return { appTitle: general.appTitle, base, profileLink: `${base}/#/profile` };
  };
  const enabled = (key) => Boolean(app.settings.read('notifications')[key]);
  const user = (id) => db.get('SELECT id, username, display_name, email, active, dnd FROM users WHERE id = ?', id);
  const nameOf = (u) => (u ? u.display_name || u.username : '');
  const teamLink = (base, teamId, tab = '') => `${base}/#/team/${teamId}${tab ? `/${tab}` : ''}`;
  const playing = (teamId) => T.players(db, teamId);

  // Returns 1 when an email was queued, 0 when the person is not reachable or
  // asked not to be disturbed.
  function send(kind, to, msg) {
    if (!to || !to.email || !to.active || to.dnd) return 0;
    try {
      app.mailer.enqueue({ to: to.email, toName: nameOf(to), kind, ...msg });
      return 1;
    } catch (err) {
      console.error(`notify ${kind}: ${err.message}`);
      return 0;
    }
  }

  function guard(fn) {
    return (...args) => {
      try { return fn(...args); } catch (err) { console.error(`notify: ${err.message}`); return 0; }
    };
  }

  const matchedOne = guard((team, santaId, childId) => {
    const { appTitle, base, profileLink } = ctx();
    const santa = user(santaId);
    if (!santa || !user(childId)) return 0;
    return send('matched', santa, emails.matched({
      appTitle,
      profileLink,
      santaName: nameOf(santa),
      teamName: team.name,
      budget: team.budget,
      startDate: team.start_date,
      endDate: team.end_date,
      link: teamLink(base, team.id, 'child'),
    }));
  });

  const matchedAll = guard((team) => {
    let n = 0;
    for (const m of db.all('SELECT santa_id, child_id FROM matches WHERE team_id = ?', team.id)) n += matchedOne(team, m.santa_id, m.child_id);
    return n;
  });

  const start = guard((team) => {
    const { appTitle, base, profileLink } = ctx();
    let n = 0;
    for (const m of playing(team.id)) {
      n += send('start', user(m.userId), emails.start({
        appTitle, profileLink, name: m.name, teamName: team.name, endDate: team.end_date, link: teamLink(base, team.id),
      }));
    }
    return n;
  });

  const reveal = guard((team) => {
    const { appTitle, base, profileLink } = ctx();
    let n = 0;
    for (const m of playing(team.id)) {
      const santaId = T.santaOf(db, team.id, m.userId);
      n += send('reveal', user(m.userId), emails.reveal({
        appTitle, profileLink, name: m.name, teamName: team.name, santaName: santaId ? T.userName(db, santaId) : '', link: teamLink(base, team.id, 'santa'),
      }));
    }
    return n;
  });

  const reminder = guard((team) => {
    const { appTitle, base, profileLink } = ctx();
    let n = 0;
    for (const m of playing(team.id)) {
      n += send('reminder', user(m.userId), emails.reminder({ appTitle, profileLink, name: m.name, teamName: team.name, startDate: team.start_date, link: `${base}/#/wishlist` }));
    }
    return n;
  });

  // Phase 1: everyone playing who has not checked in their location yet.
  const locationTargets = (team) => playing(team.id).filter((m) => !m.confirmedAt);
  const locationReminder = guard((team) => {
    const { appTitle, base, profileLink } = ctx();
    let n = 0;
    for (const m of locationTargets(team)) {
      n += send('locationReminder', user(m.userId), emails.locationReminder({
        appTitle, profileLink, name: m.name, teamName: team.name, deadline: team.location_deadline,
        locationName: m.locationName, link: teamLink(base, team.id, 'team'),
      }));
    }
    return n;
  });

  // Phase 2: every Santa who has not logged a final gift yet.
  const giftTargets = (team) => db.all(`
    SELECT m.santa_id, m.child_id,
           (SELECT COUNT(*) FROM gifts g WHERE g.team_id = m.team_id AND g.santa_id = m.santa_id AND g.child_id = m.child_id) AS gifts
      FROM matches m
     WHERE m.team_id = ?
       AND NOT EXISTS (SELECT 1 FROM gifts g WHERE g.team_id = m.team_id AND g.santa_id = m.santa_id AND g.child_id = m.child_id AND g.is_final = 1)`, team.id);
  const giftReminder = guard((team) => {
    const { appTitle, base, profileLink } = ctx();
    const daysLeft = Math.max(0, Math.round((Date.parse(`${team.end_date}T00:00:00Z`) - Date.parse(`${today()}T00:00:00Z`)) / 86400e3));
    let n = 0;
    for (const t of giftTargets(team)) {
      const santa = user(t.santa_id);
      n += send('giftReminder', santa, emails.giftReminder({
        appTitle, profileLink, name: nameOf(santa), teamName: team.name,
        endDate: team.end_date, daysLeft, giftsSoFar: t.gifts, link: teamLink(base, team.id, 'child'),
      }));
    }
    return n;
  });

  const taskAssigned = guard((team, task) => {
    const { appTitle, base, profileLink } = ctx();
    const child = user(task.child_id);
    return send('taskAssigned', child, emails.taskAssigned({
      appTitle, profileLink, childName: nameOf(child), teamName: team.name, title: task.title, details: task.details,
      dueDate: task.due_date, link: teamLink(base, team.id, 'santa'),
    }));
  });

  const giftLogged = guard((team, gift) => {
    const { appTitle, base, profileLink } = ctx();
    const child = user(gift.child_id);
    return send('giftLogged', child, emails.giftLogged({
      appTitle, profileLink, childName: nameOf(child), teamName: team.name, description: gift.description,
      isFinal: Boolean(gift.is_final), link: teamLink(base, team.id, 'santa'),
    }));
  });

  // The child is told "your Secret Santa" - never a name.
  const message = guard((team, msg) => {
    const { appTitle, base, profileLink } = ctx();
    const toId = msg.from_santa ? msg.child_id : msg.santa_id;
    const to = user(toId);
    const fromLabel = msg.from_santa ? 'your Secret Santa' : 'your child';
    return send('message', to, emails.message({
      appTitle, profileLink, toName: nameOf(to), fromLabel, teamName: team.name, body: msg.body,
      link: teamLink(base, team.id, msg.from_santa ? 'santa' : 'child'),
    }));
  });

  // The automatic rounds, run by the daily scheduler. For each kind, a round
  // goes out on each "reminder day" before the deadline (team.reminder_days,
  // e.g. "3,1"). If the server was down on that day, the latest missed round
  // is sent once and the earlier ones are skipped - never a burst of emails.
  function dueRound(team, kind, deadline, day = today()) {
    if (!deadline) return null;
    const due = T.reminderOffsets(team).filter((o) => day >= addDays(deadline, -o) && day <= deadline);
    if (!due.length) return null;
    const offset = Math.min(...due);
    const sent = db.get('SELECT 1 FROM reminders_sent WHERE team_id = ? AND kind = ? AND offset_days = ?', team.id, kind, offset);
    return sent ? null : { offset, due };
  }

  function recordRound(team, kind, offsets, recipients, manual = false) {
    const at = new Date().toISOString();
    for (const o of offsets) {
      db.run(`INSERT INTO reminders_sent (team_id, kind, offset_days, sent_at, recipients, manual) VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT(team_id, kind, offset_days) DO NOTHING`, team.id, kind, o, at, recipients, manual ? 1 : 0);
    }
  }

  function runScheduled(team, day = today()) {
    const out = [];
    const matched = T.matchCount(db, team.id) > 0;
    if (!matched && enabled('locationReminder')) {
      const r = dueRound(team, 'location', team.location_deadline, day);
      if (r) {
        const n = locationReminder(team);
        recordRound(team, 'location', r.due, n);
        out.push({ kind: 'location', offset: r.offset, recipients: n });
      }
    }
    if (matched && T.phaseOf(team, true, day) === 'live' && enabled('giftReminder')) {
      const r = dueRound(team, 'gift', team.end_date, day);
      if (r) {
        const n = giftReminder(team);
        recordRound(team, 'gift', r.due, n);
        out.push({ kind: 'gift', offset: r.offset, recipients: n });
      }
    }
    return out;
  }

  // An admin's "send a gentle nudge now": logged with a negative offset so it
  // never blocks an automatic round.
  function sendNow(team, kind) {
    const n = kind === 'location' ? locationReminder(team) : giftReminder(team);
    const seq = db.get('SELECT COALESCE(MIN(offset_days), 0) AS m FROM reminders_sent WHERE team_id = ? AND kind = ?', team.id, kind).m;
    recordRound(team, kind, [Math.min(seq, 0) - 1], n, true);
    return n;
  }

  // Who a nudge would reach right now, for the admin screen.
  function audience(team, kind) {
    if (kind === 'location') {
      const list = locationTargets(team);
      return { total: list.length, reachable: list.filter((m) => m.email && m.active && !m.dnd).length };
    }
    const list = giftTargets(team).map((t) => user(t.santa_id)).filter(Boolean);
    return { total: list.length, reachable: list.filter((u) => u.email && u.active && !u.dnd).length };
  }

  return {
    enabled,
    matchedOne: (...a) => (enabled('matched') ? matchedOne(...a) : 0),
    matchedAll: (...a) => (enabled('matched') ? matchedAll(...a) : 0),
    start: (...a) => (enabled('start') ? start(...a) : 0),
    reveal: (...a) => (enabled('reveal') ? reveal(...a) : 0),
    reminder,
    taskAssigned: (...a) => (enabled('taskAssigned') ? taskAssigned(...a) : 0),
    giftLogged: (...a) => (enabled('giftLogged') ? giftLogged(...a) : 0),
    message: (...a) => (enabled('messages') ? message(...a) : 0),
    locationReminder,
    giftReminder,
    runScheduled,
    sendNow,
    audience,
  };
}

module.exports = { create };
