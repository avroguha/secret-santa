'use strict';
// Team (game) logic shared by the player and admin APIs: who is in which
// pool, the draw, and keeping the circle whole when people join late or drop
// out after the draw.
const { fail, nowIso, today } = require('../lib/util');
const { drawPool, buildPools, makeExcluder, MatchError, cryptoRng, shuffle } = require('../lib/matching');

const HINT_KEYS = ['likes', 'dislikes', 'hobbies', 'colours', 'sizes', 'note'];

function parseHints(raw) {
  let h = {};
  try { h = JSON.parse(raw || '{}') || {}; } catch { h = {}; }
  const out = {};
  for (const k of HINT_KEYS) out[k] = typeof h[k] === 'string' ? h[k] : '';
  return out;
}

function getTeam(db, id) {
  const t = db.get('SELECT * FROM teams WHERE id = ?', id);
  if (!t) throw fail(404, 'That team does not exist');
  return t;
}

const matchCount = (db, teamId) => db.get('SELECT COUNT(*) AS n FROM matches WHERE team_id = ?', teamId).n;

function phaseOf(team, matched, day = today()) {
  if (!matched) return 'setup';
  if (day < team.start_date) return 'drawn';
  if (day <= team.end_date) return 'live';
  return 'ended';
}

const isRevealed = (team, day = today()) => Boolean(team.revealed) || (team.reveal_mode === 'after_end' && day > team.end_date);

// Everyone in the team, including those sitting this one out (optedOut).
function members(db, teamId) {
  return db.all(`
    SELECT u.id AS userId, u.username, u.display_name, u.email, u.external_id AS externalId, u.active, u.dnd,
           tm.location_id AS teamLocationId, u.location_id AS profileLocationId,
           COALESCE(tm.location_id, u.location_id) AS locationId, l.name AS locationName,
           tm.pool_location_id AS poolLocationId, pl.name AS poolLocationName, tm.joined_at AS joinedAt,
           tm.opted_out, tm.opted_out_at AS optedOutAt, tm.location_confirmed_at AS confirmedAt
      FROM team_members tm
      JOIN users u ON u.id = tm.user_id
      LEFT JOIN locations l ON l.id = COALESCE(tm.location_id, u.location_id)
      LEFT JOIN locations pl ON pl.id = tm.pool_location_id
     WHERE tm.team_id = ?
     ORDER BY COALESCE(NULLIF(u.display_name, ''), u.username) COLLATE NOCASE`, teamId)
    .map((m) => ({ ...m, name: m.display_name || m.username, optedOut: Boolean(m.opted_out), dnd: Boolean(m.dnd) }));
}

// The people who are actually playing.
const players = (db, teamId) => members(db, teamId).filter((m) => !m.optedOut);

// Phase 1, "check in": people say where they play from until the location
// deadline (if the admin set one) and before names are drawn.
function checkInOpen(team, matched, day = today()) {
  if (matched) return false;
  return !team.location_deadline || day <= team.location_deadline;
}

// "3,1" -> [3, 1]: the days before a deadline when a gentle reminder goes out.
function reminderOffsets(team) {
  return [...new Set(String(team.reminder_days || '').split(/[\s,;]+/).map(Number)
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 60))].sort((a, b) => b - a);
}

const exclusionPairs = (db, teamId) => db.all('SELECT user_a AS a, user_b AS b FROM exclusions WHERE team_id = ?', teamId);
const excluderFor = (db, teamId) => makeExcluder(exclusionPairs(db, teamId).map((e) => [e.a, e.b]));
const userName = (db, id) => {
  const u = db.get('SELECT username, display_name FROM users WHERE id = ?', id);
  return u ? (u.display_name || u.username) : `#${id}`;
};

function analyse(db, team) {
  const list = members(db, team.id);
  const playing = list.filter((m) => !m.optedOut);
  const pools = buildPools(playing, { scope: team.match_scope, minGroupSize: team.min_group_size });
  const santas = new Set(db.all('SELECT santa_id FROM matches WHERE team_id = ?', team.id).map((r) => r.santa_id));
  const matched = santas.size > 0;
  return {
    members: list,
    playing,
    pools,
    matched,
    unmatched: matched ? playing.filter((m) => !santas.has(m.userId)).map((m) => m.userId) : [],
    sittingOut: list.filter((m) => m.optedOut).map((m) => m.userId),
    checkIn: {
      deadline: team.location_deadline || null,
      open: checkInOpen(team, matched),
      confirmed: playing.filter((m) => m.confirmedAt).length,
      total: playing.length,
    },
  };
}

// One line per game, for lists (the owner's games, the admin's platform view).
function summary(db, t, day = today()) {
  const a = analyse(db, t);
  const owner = t.owner_id ? db.get('SELECT id, username, display_name, email FROM users WHERE id = ?', t.owner_id) : null;
  return {
    ...publicTeam(t, {
      phase: phaseOf(t, a.matched, day),
      revealed: a.matched && isRevealed(t, day),
      memberCount: a.playing.length,
    }),
    owner: owner ? { id: owner.id, name: owner.display_name || owner.username, email: owner.email } : null,
    sittingOut: a.sittingOut.length,
    checkIn: a.checkIn,
    minGroupSize: t.min_group_size,
    drawCount: t.draw_count,
    poolErrors: a.pools.filter((p) => p.level === 'error').length,
    poolWarnings: a.pools.filter((p) => p.level === 'warn').length,
    unmatched: a.unmatched.length,
    activity: activityCount(db, t.id),
    createdAt: t.created_at,
  };
}

// Warnings an owner should see about one of their games.
function ownerWarnings(s, day = today()) {
  const w = [];
  const link = `#/manage/${s.id}`;
  if (s.phase === 'setup' && s.poolErrors) w.push({ level: 'warn', text: `${s.name}: ${s.poolErrors} location${s.poolErrors === 1 ? '' : 's'} need adjusting before names can be drawn.`, link });
  if (s.phase === 'setup' && s.checkIn.deadline && s.checkIn.deadline < day && s.checkIn.confirmed < s.checkIn.total) {
    w.push({ level: 'info', text: `${s.name}: check-in closed with ${s.checkIn.total - s.checkIn.confirmed} of ${s.checkIn.total} not checked in - their usual location is used, or set it for them.`, link });
  }
  if (s.unmatched) w.push({ level: 'warn', text: `${s.name}: ${s.unmatched} player${s.unmatched === 1 ? ' is' : 's are'} not in the circle yet.`, link });
  return w;
}

function activityCount(db, teamId) {
  const g = db.get('SELECT COUNT(*) AS n FROM gifts WHERE team_id = ?', teamId).n;
  const t = db.get('SELECT COUNT(*) AS n FROM tasks WHERE team_id = ?', teamId).n;
  const m = db.get('SELECT COUNT(*) AS n FROM messages WHERE team_id = ?', teamId).n;
  return { gifts: g, tasks: t, messages: m, total: g + t + m };
}

// Draw (or redraw) the whole team. A redraw starts the game over, so the gifts,
// tasks and notes logged against the old pairs go with it.
function draw(db, team, rng = cryptoRng) {
  return db.tx(() => {
    const list = players(db, team.id);
    if (list.length < 2) throw fail(409, 'A team needs at least two players before names can be drawn (people sitting out do not count)');
    const pools = buildPools(list, { scope: team.match_scope, minGroupSize: team.min_group_size });
    const blocking = pools.filter((p) => p.level === 'error');
    if (blocking.length) {
      throw fail(409, 'Fix the highlighted locations before drawing names', {
        problems: blocking.map((p) => `${p.label}: ${p.issues.join(' ')}`),
      });
    }
    const isExcluded = excluderFor(db, team.id);
    const result = [];
    const problems = [];
    for (const p of pools) {
      try {
        result.push(...drawPool(p.memberIds, isExcluded, rng));
      } catch (err) {
        if (!(err instanceof MatchError)) throw err;
        problems.push(`${p.label} ${err.message}`);
      }
    }
    if (problems.length) throw fail(409, 'Names could not be drawn', { problems });
    for (const table of ['matches', 'gifts', 'tasks', 'messages']) db.run(`DELETE FROM ${table} WHERE team_id = ?`, team.id);
    const at = nowIso();
    for (const m of result) {
      db.run('INSERT INTO matches (team_id, santa_id, child_id, created_at) VALUES (?, ?, ?, ?)', team.id, m.santa, m.child, at);
    }
    // Drawn on or after the start date: the match email already says the game is on.
    db.run(`UPDATE teams SET drawn_at = ?, draw_count = draw_count + 1, revealed = 0,
            start_notified = CASE WHEN ? >= start_date THEN 1 ELSE 0 END, reveal_notified = 0, updated_at = ? WHERE id = ?`, at, today(), at, team.id);
    // A new draw starts the gift reminders over.
    db.run("DELETE FROM reminders_sent WHERE team_id = ? AND kind = 'gift'", team.id);
    return result;
  });
}

function undraw(db, team) {
  db.tx(() => {
    for (const table of ['matches', 'gifts', 'tasks', 'messages']) db.run(`DELETE FROM ${table} WHERE team_id = ?`, team.id);
    db.run('UPDATE teams SET drawn_at = NULL, revealed = 0, start_notified = 0, reveal_notified = 0, updated_at = ? WHERE id = ?', nowIso(), team.id);
  });
}

function poolKeyMap(db, team) {
  const { pools } = analyse(db, team);
  const map = new Map();
  for (const p of pools) for (const id of p.memberIds) map.set(id, p);
  return map;
}

// Take someone out of a drawn circle and close the gap: their Santa takes over
// their child. Returns notes for the admin about anything left imperfect, and
// the user ids whose child changed (so they can be told).
function removeFromCircle(db, team, userId) {
  const notes = [];
  const changed = [];
  const asSanta = db.get('SELECT child_id FROM matches WHERE team_id = ? AND santa_id = ?', team.id, userId);
  const asChild = db.get('SELECT santa_id FROM matches WHERE team_id = ? AND child_id = ?', team.id, userId);
  const pools = poolKeyMap(db, team);
  db.run('DELETE FROM matches WHERE team_id = ? AND (santa_id = ? OR child_id = ?)', team.id, userId, userId);
  if (!asSanta || !asChild) return { notes, changed };
  const s = asChild.santa_id;
  const c = asSanta.child_id;
  if (s === c) {
    notes.push(`${userName(db, s)} was in a pair of two and now has no child and no Santa. Add them to another circle with "Insert", or redraw.`);
    return { notes, changed };
  }
  const isExcluded = excluderFor(db, team.id);
  const insert = (santa, child) => db.run('INSERT INTO matches (team_id, santa_id, child_id, created_at) VALUES (?, ?, ?, ?)', team.id, santa, child, nowIso());
  if (!isExcluded(s, c)) {
    insert(s, c);
    changed.push(s);
    return { notes, changed };
  }
  // s may not give to c: swap with another pair in the same pool instead.
  const poolKey = pools.get(s) && pools.get(s).key;
  const edges = db.all('SELECT santa_id, child_id FROM matches WHERE team_id = ?', team.id)
    .filter((e) => pools.get(e.santa_id) && pools.get(e.santa_id).key === poolKey);
  for (const e of shuffle(edges)) {
    if (e.child_id === s || e.santa_id === c) continue;
    if (isExcluded(s, e.child_id) || isExcluded(e.santa_id, c)) continue;
    db.run('UPDATE matches SET child_id = ? WHERE team_id = ? AND santa_id = ?', c, team.id, e.santa_id);
    insert(s, e.child_id);
    changed.push(s, e.santa_id);
    return { notes, changed };
  }
  insert(s, c);
  changed.push(s);
  notes.push(`${userName(db, s)} now gives to ${userName(db, c)} although the two are excluded from each other - no swap was possible. Redraw if that matters.`);
  return { notes, changed };
}

// Fit a late joiner into a drawn circle: pick a random A -> B in their pool and
// make it A -> newcomer -> B. Only A's child changes.
function insertIntoCircle(db, team, userId, rng = cryptoRng) {
  return db.tx(() => {
    if (!db.get('SELECT 1 FROM team_members WHERE team_id = ? AND user_id = ?', team.id, userId)) throw fail(404, 'That person is not in this team');
    if (db.get('SELECT 1 FROM matches WHERE team_id = ? AND (santa_id = ? OR child_id = ?)', team.id, userId, userId)) {
      throw fail(409, 'That person is already in the circle');
    }
    if (db.get('SELECT opted_out FROM team_members WHERE team_id = ? AND user_id = ?', team.id, userId).opted_out) {
      throw fail(409, 'That person is sitting this one out - bring them back first');
    }
    const pools = poolKeyMap(db, team);
    const pool = pools.get(userId);
    if (!pool || pool.key === 'none') throw fail(409, 'Give this person a location first');
    const isExcluded = excluderFor(db, team.id);
    const edges = db.all('SELECT santa_id, child_id FROM matches WHERE team_id = ?', team.id)
      .filter((e) => pools.get(e.santa_id) && pools.get(e.santa_id).key === pool.key)
      .filter((e) => !isExcluded(e.santa_id, userId) && !isExcluded(userId, e.child_id));
    if (!edges.length) {
      throw fail(409, `There is no circle to join in ${pool.label} yet (or every spot is excluded). Merge them into another location, or redraw.`);
    }
    const e = edges[rng.int(edges.length)];
    db.run('UPDATE matches SET child_id = ? WHERE team_id = ? AND santa_id = ?', userId, team.id, e.santa_id);
    db.run('INSERT INTO matches (team_id, santa_id, child_id, created_at) VALUES (?, ?, ?, ?)', team.id, userId, e.child_id, nowIso());
    return { santaId: e.santa_id, childId: e.child_id };
  });
}

const childOf = (db, teamId, userId) => {
  const r = db.get('SELECT child_id FROM matches WHERE team_id = ? AND santa_id = ?', teamId, userId);
  return r ? r.child_id : null;
};
const santaOf = (db, teamId, userId) => {
  const r = db.get('SELECT santa_id FROM matches WHERE team_id = ? AND child_id = ?', teamId, userId);
  return r ? r.santa_id : null;
};

function wishlist(db, userId) {
  return db.all('SELECT id, title, url, notes, priority, created_at AS createdAt FROM wishlist_items WHERE user_id = ? ORDER BY priority, id', userId);
}

const giftRow = (g, { forChild = false } = {}) => ({
  id: g.id,
  description: g.description,
  url: g.url,
  givenOn: g.given_on,
  isFinal: Boolean(g.is_final),
  receivedAt: g.received_at,
  thanks: g.thanks,
  createdAt: g.created_at,
  ...(forChild ? {} : { childId: g.child_id }),
});

const taskRow = (t) => ({
  id: t.id,
  title: t.title,
  details: t.details,
  dueDate: t.due_date,
  status: t.status,
  doneNote: t.done_note,
  doneAt: t.done_at,
  createdAt: t.created_at,
});

// Everything one player may see about one team. The child's identity is shown
// to their Santa; the Santa's identity is never part of this object unless the
// team has been revealed.
function memberView(db, team, userId, day = today()) {
  const list = members(db, team.id);
  const me = list.find((m) => m.userId === userId);
  if (!me) throw fail(403, 'You are not playing in this team');
  const matched = matchCount(db, team.id) > 0;
  const phase = phaseOf(team, matched, day);
  const revealed = isRevealed(team, day) && matched;
  const childId = childOf(db, team.id, userId);
  const santaId = santaOf(db, team.id, userId);

  let child = null;
  if (childId) {
    const c = list.find((m) => m.userId === childId)
      || { userId: childId, name: userName(db, childId), locationName: null };
    const hintsRow = db.get('SELECT hints FROM users WHERE id = ?', childId);
    child = {
      id: childId,
      name: c.name,
      location: c.locationName,
      hints: parseHints(hintsRow && hintsRow.hints),
      wishlist: wishlist(db, childId),
      giftsGiven: db.all('SELECT * FROM gifts WHERE team_id = ? AND santa_id = ? AND child_id = ? ORDER BY given_on, id', team.id, userId, childId).map((g) => giftRow(g)),
      tasksGiven: db.all('SELECT * FROM tasks WHERE team_id = ? AND santa_id = ? AND child_id = ? ORDER BY id', team.id, userId, childId).map(taskRow),
      unread: db.get('SELECT COUNT(*) AS n FROM messages WHERE team_id = ? AND santa_id = ? AND child_id = ? AND from_santa = 0 AND read_at IS NULL', team.id, userId, childId).n,
    };
  }

  const fromSanta = {
    gifts: db.all('SELECT * FROM gifts WHERE team_id = ? AND child_id = ? ORDER BY given_on, id', team.id, userId).map((g) => giftRow(g, { forChild: true })),
    tasks: db.all('SELECT * FROM tasks WHERE team_id = ? AND child_id = ? ORDER BY id', team.id, userId).map(taskRow),
    unread: santaId ? db.get('SELECT COUNT(*) AS n FROM messages WHERE team_id = ? AND santa_id = ? AND child_id = ? AND from_santa = 1 AND read_at IS NULL', team.id, santaId, userId).n : 0,
    hasSanta: Boolean(santaId),
    santaName: revealed && santaId ? userName(db, santaId) : null,
  };

  const playing = list.filter((m) => !m.optedOut);
  return {
    team: publicTeam(team, { phase, revealed, memberCount: playing.length }),
    me: {
      locationId: me.locationId,
      teamLocationId: me.teamLocationId,
      locationName: me.locationName,
      optedOut: me.optedOut,
      confirmedAt: me.confirmedAt,
    },
    members: playing.map((m) => ({ id: m.userId, name: m.name, location: m.locationName })),
    sittingOut: list.length - playing.length,
    checkIn: { open: checkInOpen(team, matched, day), deadline: team.location_deadline || null },
    canOptOut: !matched,
    child,
    fromSanta,
    canPlay: matched && phase === 'live',
    canMessage: matched && (phase === 'drawn' || phase === 'live'),
  };
}

function publicTeam(team, extra = {}) {
  return {
    id: team.id,
    name: team.name,
    description: team.description,
    guidelines: team.guidelines || '',
    startDate: team.start_date,
    endDate: team.end_date,
    locationDeadline: team.location_deadline || null,
    reminderDays: team.reminder_days || '',
    budget: team.budget,
    matchScope: team.match_scope,
    revealMode: team.reveal_mode,
    joinOpen: Boolean(team.join_open),
    drawnAt: team.drawn_at,
    ...extra,
  };
}

function board(db, teamId, viewerId) {
  return db.all(`
    SELECT t.*, COALESCE(NULLIF(u.display_name, ''), u.username) AS child_name,
           (SELECT COUNT(*) FROM task_cheers c WHERE c.task_id = t.id) AS cheers,
           EXISTS (SELECT 1 FROM task_cheers c WHERE c.task_id = t.id AND c.user_id = ?) AS cheered
      FROM tasks t JOIN users u ON u.id = t.child_id
     WHERE t.team_id = ?
     ORDER BY CASE t.status WHEN 'open' THEN 0 ELSE 1 END, COALESCE(t.done_at, t.created_at) DESC`, viewerId, teamId)
    .map((t) => ({
      ...taskRow(t),
      childId: t.child_id,
      childName: t.child_name,
      cheers: t.cheers,
      cheered: Boolean(t.cheered),
      forMe: t.child_id === viewerId,
      byMe: t.santa_id === viewerId,
    }));
}

module.exports = {
  players, checkInOpen, reminderOffsets, summary, ownerWarnings,
  HINT_KEYS, parseHints, getTeam, matchCount, phaseOf, isRevealed, members, exclusionPairs, analyse,
  activityCount, draw, undraw, removeFromCircle, insertIntoCircle, childOf, santaOf, wishlist,
  memberView, publicTeam, board, userName, giftRow, taskRow,
};
