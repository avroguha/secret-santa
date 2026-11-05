'use strict';
// Running a game: everything its OWNER (the person who created it) does -
// players, locations, exclusions, the draw, reminders, the reveal. Any
// signed-in person can create a game and becomes its owner. Platform admins
// do not run other people's games (they can only hand one to a new owner, or
// delete it, under /api/admin/games).
const { fail, text, id, optionalId, int, bool, date, oneOf, nowIso, today, maskEmail, normEmail } = require('../lib/util');
const T = require('../services/teams');

const M = { auth: 'user' };

module.exports = function manageRoutes(router, app) {
  const { db } = app;

  // Invite codes: short, unambiguous, unguessable (alphabet without 0/O/1/I/L).
  const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
  function newInviteCode() {
    const bytes = require('node:crypto').randomBytes(10);
    let code = '';
    for (const b of bytes) code += ALPHABET[b % ALPHABET.length];
    return code;
  }

  // Only the game's owner runs it.
  const loadTeam = (ctx) => {
    const team = T.getTeam(db, id(ctx.params.teamId, 'game'));
    if (team.owner_id !== ctx.user.id) throw fail(403, "Only this game's organiser can do that");
    return team;
  };

  // Organisers who play see every pairing - including their own Santa. They
  // join their own game only after saying they understand that.
  // Emails to a whole game that the organiser sends by hand (nudges, re-sends,
  // a draw with emails). Generous for a real game, useless for spamming.
  function mailBudget(ctx, team) {
    app.auth.limit(`team-mail:${team.id}`, 6, 86400e3, 'This game has had six team emails today - give everyone a breather and try again tomorrow');
    app.auth.limit(`organiser-mail:${ctx.user.id}`, 15, 86400e3, "You've sent a lot of team emails today - try again tomorrow");
  }

  function ownerAck(ctx, team) {
    if (team.owner_ack_at) return;
    if (!bool(ctx.body.ownerAck)) {
      throw fail(409, 'As the organiser you can see the whole Santa list - including who YOUR Santa is. Tick the box to say that is fine, then join.', { code: 'owner_ack' });
    }
    db.run('UPDATE teams SET owner_ack_at = ? WHERE id = ?', nowIso(), team.id);
    app.audit(ctx, 'accepted seeing their own Santa as organiser', team.name);
  }

  // ---- games ------------------------------------------------------------------------------
  // "3, 1" -> "3,1": the days before each deadline when a gentle reminder goes
  // out. Empty = no automatic reminders for this team.
  function reminderDays(v) {
    const raw = text(v, { field: 'Reminder days', max: 40 });
    if (!raw) return '';
    const nums = raw.split(/[\s,;]+/).filter(Boolean).map(Number);
    if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 60)) throw fail(400, 'Reminder days are whole numbers of days, 0 to 60, like "3, 1"');
    if (nums.length > 5) throw fail(400, 'At most five reminder days - keep it gentle!');
    return [...new Set(nums)].sort((a, b) => b - a).join(',');
  }

  function teamFields(b, existing) {
    const f = {
      name: text(b.name, { field: 'Team name', max: 80, required: true }),
      description: text(b.description, { field: 'Description', max: 2000, multiline: true }),
      startDate: date(b.startDate, 'Start date', { required: true }),
      endDate: date(b.endDate, 'End date', { required: true }),
      budget: text(b.budget, { field: 'Budget', max: 40 }),
      matchScope: oneOf(b.matchScope, 'Match scope', ['location', 'all'], existing ? existing.match_scope : 'location'),
      minGroupSize: int(b.minGroupSize, 'Minimum group size', { min: 2, max: 50, fallback: existing ? existing.min_group_size : 3 }),
      revealMode: oneOf(b.revealMode, 'Reveal', ['after_end', 'manual'], existing ? existing.reveal_mode : 'after_end'),
      joinOpen: b.joinOpen === undefined ? (existing ? existing.join_open : 0) : (bool(b.joinOpen) ? 1 : 0),
      locationDeadline: b.locationDeadline === undefined ? (existing ? existing.location_deadline : null) : date(b.locationDeadline, 'Check-in date'),
      reminderDays: b.reminderDays === undefined ? (existing ? existing.reminder_days : '3,1') : reminderDays(b.reminderDays),
      guidelines: b.guidelines === undefined ? (existing ? existing.guidelines : '') : text(b.guidelines, { field: 'Guidelines', max: 5000, multiline: true }),
    };
    if (f.endDate < f.startDate) throw fail(400, 'The end date must be on or after the start date');
    if (f.locationDeadline && f.locationDeadline > f.endDate) throw fail(400, 'The check-in date must be before the game ends');
    return f;
  }

  router.get('/api/manage/teams', (ctx) => db.all('SELECT * FROM teams WHERE owner_id = ? ORDER BY start_date DESC, name', ctx.user.id).map((t) => T.summary(db, t)), M);

  router.post('/api/manage/teams', (ctx) => {
    const f = teamFields(ctx.body);
    const at = nowIso();
    const copyFrom = optionalId(ctx.body.copyFrom, 'Copy from');
    if (copyFrom && T.getTeam(db, copyFrom).owner_id !== ctx.user.id) throw fail(403, 'You can only copy players from a game you organise');
    let teamId;
    try {
      teamId = db.run(`INSERT INTO teams (name, description, start_date, end_date, budget, match_scope, min_group_size, reveal_mode, join_open,
                         location_deadline, reminder_days, guidelines, owner_id, invite_code, created_at, updated_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, f.name, f.description, f.startDate, f.endDate, f.budget, f.matchScope, f.minGroupSize, f.revealMode, f.joinOpen,
      f.locationDeadline, f.reminderDays, f.guidelines, ctx.user.id, newInviteCode(), at, at).lastInsertRowid;
    } catch (err) {
      if (/UNIQUE/.test(err.message)) throw fail(409, `A game called ${f.name} already exists - pick another name`);
      throw err;
    }
    // Copy members (and optionally exclusions) from an earlier team.
    if (copyFrom) {
      db.run(`INSERT INTO team_members (team_id, user_id, location_id, pool_location_id, joined_at)
              SELECT ?, user_id, location_id, pool_location_id, ? FROM team_members WHERE team_id = ?`, teamId, at, copyFrom);
      db.run('INSERT INTO exclusions (team_id, user_a, user_b, created_at) SELECT ?, user_a, user_b, ? FROM exclusions WHERE team_id = ?', teamId, at, copyFrom);
      // "Don't give to the same person as last time": exclude last draw's pairs.
      if (bool(ctx.body.avoidPrevious)) {
        for (const m of db.all('SELECT santa_id, child_id FROM matches WHERE team_id = ?', copyFrom)) {
          const [a, b] = m.santa_id < m.child_id ? [m.santa_id, m.child_id] : [m.child_id, m.santa_id];
          db.run('INSERT OR IGNORE INTO exclusions (team_id, user_a, user_b, created_at) VALUES (?, ?, ?, ?)', teamId, a, b, at);
        }
      }
    }
    // The organiser playing too, after accepting the spoiler.
    if (bool(ctx.body.ownerPlays)) {
      const team = T.getTeam(db, teamId);
      ownerAck(ctx, team);
      db.run('INSERT OR IGNORE INTO team_members (team_id, user_id, joined_at) VALUES (?, ?, ?)', teamId, ctx.user.id, at);
      T.sayYes(db, teamId, ctx.user.id);
    }
    app.audit(ctx, 'created a game', f.name);
    return { id: teamId };
  }, M);

  function teamDetail(team) {
    const a = T.analyse(db, team);
    const day = today();
    const matchRows = db.all('SELECT santa_id, child_id FROM matches WHERE team_id = ?', team.id);
    const santaOf = new Map(matchRows.map((m) => [m.child_id, m.santa_id]));
    const childOf = new Map(matchRows.map((m) => [m.santa_id, m.child_id]));
    const poolOf = new Map();
    for (const p of a.pools) for (const uid of p.memberIds) poolOf.set(uid, p.key);
    return {
      team: {
        ...T.publicTeam(team, {
          phase: T.phaseOf(team, a.matched, day),
          revealed: a.matched && T.isRevealed(team, day),
          memberCount: a.playing.length,
        }),
        minGroupSize: team.min_group_size,
        drawCount: team.draw_count,
        revealedFlag: Boolean(team.revealed),
        inviteCode: team.invite_code,
        ownerPlays: a.members.some((m) => m.userId === team.owner_id),
        ownerAccepted: Boolean(team.owner_ack_at),
      },
      warnings: T.ownerWarnings(T.summary(db, team, day), day),
      checkIn: a.checkIn,
      sittingOut: a.sittingOut,
      reminders: db.all('SELECT kind, offset_days AS offset, sent_at AS sentAt, recipients, manual FROM reminders_sent WHERE team_id = ? ORDER BY sent_at DESC', team.id)
        .filter((r, i, all) => all.findIndex((x) => x.kind === r.kind && x.sentAt === r.sentAt) === i)
        .map((r) => ({ ...r, manual: Boolean(r.manual) })),
      audience: { location: app.notify.audience(team, 'location'), gift: app.notify.audience(team, 'gift') },
      members: a.members.map((m) => ({
        id: m.userId,
        name: m.name,
        // Organisers tell people apart by name and a masked address; they never
        // get a full address or an employee ID.
        emailHint: maskEmail(m.email),
        active: Boolean(m.active),
        locationId: m.locationId,
        locationName: m.locationName,
        teamLocationId: m.teamLocationId,
        poolLocationId: m.poolLocationId,
        poolLocationName: m.poolLocationName,
        pool: poolOf.get(m.userId),
        inCircle: childOf.has(m.userId) && santaOf.has(m.userId),
        hasWishlist: Boolean(db.get('SELECT 1 FROM wishlist_items WHERE user_id = ? LIMIT 1', m.userId)),
        optedOut: m.optedOut,
        confirmedAt: m.confirmedAt,
        saidYes: m.accepted,
        dnd: m.dnd,
      })),
      pools: a.pools,
      unmatched: a.unmatched,
      exclusions: T.exclusionPairs(db, team.id).map((e) => ({ a: e.a, b: e.b, aName: T.userName(db, e.a), bName: T.userName(db, e.b) })),
      activity: T.activityCount(db, team.id),
      stats: {
        tasksDone: db.get("SELECT COUNT(*) AS n FROM tasks WHERE team_id = ? AND status = 'done'", team.id).n,
        finals: db.get('SELECT COUNT(*) AS n FROM gifts WHERE team_id = ? AND is_final = 1', team.id).n,
        received: db.get('SELECT COUNT(*) AS n FROM gifts WHERE team_id = ? AND received_at IS NOT NULL', team.id).n,
      },
    };
  }

  router.get('/api/manage/teams/:teamId', (ctx) => teamDetail(loadTeam(ctx)), M);

  router.put('/api/manage/teams/:teamId', (ctx) => {
    const team = loadTeam(ctx);
    const f = teamFields(ctx.body, team);
    const matched = T.matchCount(db, team.id) > 0;
    if (matched && f.matchScope !== team.match_scope) throw fail(409, 'Undo the draw before changing how people are grouped');
    try {
      db.run(`UPDATE teams SET name = ?, description = ?, start_date = ?, end_date = ?, budget = ?, match_scope = ?, min_group_size = ?,
              reveal_mode = ?, join_open = ?, location_deadline = ?, reminder_days = ?, guidelines = ?, updated_at = ? WHERE id = ?`,
      f.name, f.description, f.startDate, f.endDate, f.budget, f.matchScope, f.minGroupSize, f.revealMode, f.joinOpen,
      f.locationDeadline, f.reminderDays, f.guidelines, nowIso(), team.id);
      // A moved date (or new reminder days) starts that kind of reminder over.
      const changedDays = f.reminderDays !== team.reminder_days;
      if (changedDays || f.locationDeadline !== team.location_deadline) db.run("DELETE FROM reminders_sent WHERE team_id = ? AND kind = 'location' AND manual = 0", team.id);
      if (changedDays || f.endDate !== team.end_date) db.run("DELETE FROM reminders_sent WHERE team_id = ? AND kind = 'gift' AND manual = 0", team.id);
    } catch (err) {
      if (/UNIQUE/.test(err.message)) throw fail(409, `A game called ${f.name} already exists - pick another name`);
      throw err;
    }
    app.audit(ctx, 'updated a game', f.name);
    return teamDetail(T.getTeam(db, team.id));
  }, M);

  router.delete('/api/manage/teams/:teamId', (ctx) => {
    const team = loadTeam(ctx);
    db.run('DELETE FROM teams WHERE id = ?', team.id);
    app.audit(ctx, 'deleted a game', team.name);
    return { ok: true };
  }, M);

  // members
  router.post('/api/manage/teams/:teamId/members', (ctx) => {
    const team = loadTeam(ctx);
    let ids = Array.isArray(ctx.body.userIds) ? ctx.body.userIds.map((x) => id(x, 'person')) : [];
    const locs = [].concat(ctx.body.allFromLocations || [], ctx.body.allFromLocation || []).slice(0, 50).map((x) => id(x, 'Location'));
    for (const loc of locs) {
      // a bulk add never adds the organiser - they join on purpose, below
      ids = ids.concat(db.all('SELECT id FROM users WHERE location_id = ? AND active = 1 AND email IS NOT NULL AND id <> ?', loc, ctx.user.id).map((r) => r.id));
    }
    if (ids.includes(ctx.user.id)) ownerAck(ctx, team);
    const at = nowIso();
    let added = 0;
    db.tx(() => {
      for (const uid of new Set(ids)) {
        if (!db.get('SELECT 1 FROM users WHERE id = ? AND active = 1', uid)) continue;
        added += db.run('INSERT OR IGNORE INTO team_members (team_id, user_id, joined_at) VALUES (?, ?, ?)', team.id, uid, at).changes;
        if (uid === ctx.user.id) T.sayYes(db, team.id, uid);
      }
    });
    app.audit(ctx, 'added people to a team', `${team.name}: ${added}`);
    return { added, detail: teamDetail(T.getTeam(db, team.id)) };
  }, M);

  router.put('/api/manage/teams/:teamId/members/:userId', (ctx) => {
    const team = loadTeam(ctx);
    const uid = id(ctx.params.userId);
    const row = db.get('SELECT * FROM team_members WHERE team_id = ? AND user_id = ?', team.id, uid);
    if (!row) throw fail(404, 'That person is not in this team');
    const inCircle = db.get('SELECT 1 FROM matches WHERE team_id = ? AND (santa_id = ? OR child_id = ?)', team.id, uid, uid);
    if (inCircle) throw fail(409, 'This person is already in the drawn circle - take them out first, or undo the draw');
    const b = ctx.body;
    if (b.optedOut !== undefined) {
      const out = bool(b.optedOut);
      db.run('UPDATE team_members SET opted_out = ?, opted_out_at = ? WHERE team_id = ? AND user_id = ?', out ? 1 : 0, out ? nowIso() : null, team.id, uid);
      app.audit(ctx, out ? 'marked someone as sitting out' : 'brought someone back in', `${team.name}: ${T.userName(db, uid)}`);
      return teamDetail(team);
    }
    const loc = b.locationId === undefined ? row.location_id : optionalId(b.locationId, 'Location');
    const pool = b.poolLocationId === undefined ? row.pool_location_id : optionalId(b.poolLocationId, 'Match with');
    for (const l of [loc, pool]) if (l && !db.get('SELECT 1 FROM locations WHERE id = ?', l)) throw fail(400, 'Unknown location');
    // The organiser setting where someone plays from counts as their check-in.
    const confirmed = b.locationId !== undefined ? nowIso() : row.location_confirmed_at;
    db.run('UPDATE team_members SET location_id = ?, pool_location_id = ?, location_confirmed_at = ? WHERE team_id = ? AND user_id = ?', loc, pool, confirmed, team.id, uid);
    return teamDetail(team);
  }, M);

  router.delete('/api/manage/teams/:teamId/members/:userId', (ctx) => {
    const team = loadTeam(ctx);
    const uid = id(ctx.params.userId);
    const result = db.tx(() => {
      const r = T.removeFromCircle(db, team, uid);
      db.run('DELETE FROM team_members WHERE team_id = ? AND user_id = ?', team.id, uid);
      db.run('DELETE FROM exclusions WHERE team_id = ? AND (user_a = ? OR user_b = ?)', team.id, uid, uid);
      return r;
    });
    for (const s of result.changed) {
      const c = T.childOf(db, team.id, s);
      if (c) app.notify.matchedOne(team, s, c);
    }
    app.audit(ctx, 'removed someone from a team', `${team.name}: ${T.userName(db, uid)}`);
    return { notes: result.notes, detail: teamDetail(team) };
  }, M);

  router.post('/api/manage/teams/:teamId/members/:userId/insert', (ctx) => {
    const team = loadTeam(ctx);
    const uid = id(ctx.params.userId);
    const r = T.insertIntoCircle(db, team, uid);
    if (bool(ctx.body.notify)) {
      app.notify.matchedOne(team, uid, r.childId);
      app.notify.matchedOne(team, r.santaId, uid);
    }
    app.audit(ctx, 'added a late joiner to the circle', `${team.name}: ${T.userName(db, uid)}`);
    return teamDetail(team);
  }, M);

  // pools: merge one location's people into another's draw, or undo all adjustments
  router.post('/api/manage/teams/:teamId/pools/merge', (ctx) => {
    const team = loadTeam(ctx);
    if (T.matchCount(db, team.id) > 0) throw fail(409, 'Undo the draw before moving locations around');
    const into = id(ctx.body.intoLocationId, 'Merge into');
    if (!db.get('SELECT 1 FROM locations WHERE id = ?', into)) throw fail(400, 'Unknown location');
    const { pools } = T.analyse(db, team);
    const from = pools.find((p) => p.key === String(ctx.body.fromPool || ''));
    if (!from) throw fail(404, 'That group no longer exists - reload the page');
    db.tx(() => {
      for (const uid of from.memberIds) db.run('UPDATE team_members SET pool_location_id = ? WHERE team_id = ? AND user_id = ?', into, team.id, uid);
    });
    app.audit(ctx, 'merged locations for a draw', `${team.name}: ${from.label} -> ${db.get('SELECT name FROM locations WHERE id = ?', into).name}`);
    return teamDetail(team);
  }, M);

  router.post('/api/manage/teams/:teamId/pools/reset', (ctx) => {
    const team = loadTeam(ctx);
    if (T.matchCount(db, team.id) > 0) throw fail(409, 'Undo the draw before moving locations around');
    db.run('UPDATE team_members SET pool_location_id = NULL WHERE team_id = ?', team.id);
    return teamDetail(team);
  }, M);

  // exclusions
  router.post('/api/manage/teams/:teamId/exclusions', (ctx) => {
    const team = loadTeam(ctx);
    const a = id(ctx.body.a, 'First person');
    const b = id(ctx.body.b, 'Second person');
    if (a === b) throw fail(400, 'Pick two different people');
    for (const u of [a, b]) if (!db.get('SELECT 1 FROM team_members WHERE team_id = ? AND user_id = ?', team.id, u)) throw fail(400, 'Both people must be in this team');
    const [x, y] = a < b ? [a, b] : [b, a];
    db.run('INSERT OR IGNORE INTO exclusions (team_id, user_a, user_b, created_at) VALUES (?, ?, ?, ?)', team.id, x, y, nowIso());
    const clash = db.get('SELECT 1 FROM matches WHERE team_id = ? AND ((santa_id = ? AND child_id = ?) OR (santa_id = ? AND child_id = ?))', team.id, x, y, y, x);
    return { ...teamDetail(team), notice: clash ? 'These two are already matched in the current draw - redraw for the exclusion to apply.' : '' };
  }, M);

  router.delete('/api/manage/teams/:teamId/exclusions/:a/:b', (ctx) => {
    const team = loadTeam(ctx);
    const [a, b] = [id(ctx.params.a), id(ctx.params.b)];
    const [x, y] = a < b ? [a, b] : [b, a];
    db.run('DELETE FROM exclusions WHERE team_id = ? AND user_a = ? AND user_b = ?', team.id, x, y);
    return teamDetail(team);
  }, M);

  // the draw
  router.post('/api/manage/teams/:teamId/draw', (ctx) => {
    const team = loadTeam(ctx);
    const wasDrawn = T.matchCount(db, team.id) > 0;
    if (wasDrawn && !bool(ctx.body.redraw)) throw fail(409, 'Names were already drawn - confirm a redraw to start over');
    if (bool(ctx.body.notify)) mailBudget(ctx, team);
    const pairs = T.draw(db, team);
    const fresh = T.getTeam(db, team.id);
    const mailed = bool(ctx.body.notify) ? app.notify.matchedAll(fresh) : 0;
    app.audit(ctx, wasDrawn ? 'redrew names' : 'drew names', `${team.name}: ${pairs.length} people, ${mailed} emails`);
    return { ...teamDetail(fresh), mailed };
  }, M);

  router.post('/api/manage/teams/:teamId/undraw', (ctx) => {
    const team = loadTeam(ctx);
    T.undraw(db, team);
    app.audit(ctx, 'undid the draw', team.name);
    return teamDetail(T.getTeam(db, team.id));
  }, M);

  // Seeing the full list spoils the surprise, so it is its own request and logged.
  router.get('/api/manage/teams/:teamId/matches', (ctx) => {
    const team = loadTeam(ctx);
    const plays = db.get('SELECT 1 FROM team_members WHERE team_id = ? AND user_id = ? AND opted_out = 0', team.id, ctx.user.id);
    if (plays && !team.owner_ack_at) {
      throw fail(409, 'You play in this game too, so the Santa list includes who YOUR Santa is. Accept that first.', { code: 'owner_ack' });
    }
    app.audit(ctx, 'looked at the full Santa list', team.name);
    return db.all(`
      SELECT m.santa_id, m.child_id,
             COALESCE(NULLIF(s.display_name, ''), s.username) AS santa, COALESCE(NULLIF(c.display_name, ''), c.username) AS child,
             (SELECT COUNT(*) FROM gifts g WHERE g.team_id = m.team_id AND g.santa_id = m.santa_id AND g.child_id = m.child_id) AS gifts,
             (SELECT COUNT(*) FROM tasks k WHERE k.team_id = m.team_id AND k.santa_id = m.santa_id AND k.child_id = m.child_id) AS tasks,
             EXISTS (SELECT 1 FROM gifts g WHERE g.team_id = m.team_id AND g.santa_id = m.santa_id AND g.child_id = m.child_id AND g.is_final = 1) AS final
        FROM matches m JOIN users s ON s.id = m.santa_id JOIN users c ON c.id = m.child_id
       WHERE m.team_id = ? ORDER BY santa COLLATE NOCASE`, team.id)
      .map((r) => ({ santaId: r.santa_id, childId: r.child_id, santa: r.santa, child: r.child, gifts: r.gifts, tasks: r.tasks, final: Boolean(r.final) }));
  }, M);

  router.post('/api/manage/teams/:teamId/reveal', (ctx) => {
    const team = loadTeam(ctx);
    if (!T.matchCount(db, team.id)) throw fail(409, 'Draw names first');
    const revealed = ctx.body.revealed === undefined ? true : bool(ctx.body.revealed);
    db.run('UPDATE teams SET revealed = ?, updated_at = ? WHERE id = ?', revealed ? 1 : 0, nowIso(), team.id);
    let mailed = 0;
    if (revealed && bool(ctx.body.notify)) {
      mailed = app.notify.reveal(team);
      db.run('UPDATE teams SET reveal_notified = 1 WHERE id = ?', team.id);
    }
    app.audit(ctx, revealed ? 'revealed the Santas' : 'hid the Santas again', team.name);
    return { ...teamDetail(T.getTeam(db, team.id)), mailed };
  }, M);

  // "Send a gentle nudge now": check-in (before the draw) or gift (during the game).
  router.post('/api/manage/teams/:teamId/remind', (ctx) => {
    const team = loadTeam(ctx);
    const kind = oneOf(ctx.body.kind, 'Kind', ['location', 'gift']);
    const matched = T.matchCount(db, team.id) > 0;
    if (kind === 'location' && matched) throw fail(409, 'Names have been drawn - check-in is over');
    if (kind === 'gift' && !matched) throw fail(409, 'Draw names first');
    mailBudget(ctx, team);
    const mailed = app.notify.sendNow(team, kind);
    app.audit(ctx, `sent a gentle ${kind === 'location' ? 'check-in' : 'gift'} nudge`, `${team.name}: ${mailed}`);
    return { mailed, detail: teamDetail(T.getTeam(db, team.id)) };
  }, M);

  router.post('/api/manage/teams/:teamId/notify', (ctx) => {
    const team = loadTeam(ctx);
    const kind = oneOf(ctx.body.kind, 'Kind', ['matched', 'reminder', 'start']);
    if (kind === 'matched' && !T.matchCount(db, team.id)) throw fail(409, 'Draw names first');
    mailBudget(ctx, team);
    let mailed = 0;
    if (kind === 'matched') {
      if (!T.matchCount(db, team.id)) throw fail(409, 'Draw names first');
      mailed = app.notify.matchedAll(team);
    } else if (kind === 'reminder') {
      mailed = app.notify.reminder(team);
    } else {
      mailed = app.notify.start(team);
    }
    app.audit(ctx, `emailed the team (${kind})`, `${team.name}: ${mailed}`);
    return { mailed };
  }, M);

  // A fresh invite code; the old link stops working.
  router.post('/api/manage/teams/:teamId/invite/reset', (ctx) => {
    const team = loadTeam(ctx);
    db.run('UPDATE teams SET invite_code = ?, updated_at = ? WHERE id = ?', newInviteCode(), nowIso(), team.id);
    app.audit(ctx, 'made a new invite link', team.name);
    return teamDetail(T.getTeam(db, team.id));
  }, M);

  // The organiser joins (or leaves) their own game as a player.
  router.post('/api/manage/teams/:teamId/play', (ctx) => {
    const team = loadTeam(ctx);
    const play = ctx.body.play === undefined ? true : bool(ctx.body.play);
    if (play) {
      ownerAck(ctx, team);
      db.run('INSERT OR IGNORE INTO team_members (team_id, user_id, joined_at) VALUES (?, ?, ?)', team.id, ctx.user.id, nowIso());
      T.sayYes(db, team.id, ctx.user.id);
      app.audit(ctx, 'joined their own game as a player', team.name);
    } else {
      const r = T.removeFromCircle(db, team, ctx.user.id);
      db.run('DELETE FROM team_members WHERE team_id = ? AND user_id = ?', team.id, ctx.user.id);
      for (const sid of r.changed) {
        const c = T.childOf(db, team.id, sid);
        if (c) app.notify.matchedOne(team, sid, c);
      }
      app.audit(ctx, 'stopped playing in their own game', team.name);
    }
    return teamDetail(T.getTeam(db, team.id));
  }, M);

  // The people directory, for an organiser picking players. A search, not a
  // list: at least two letters, at most 25 answers, names and locations only
  // (an email matches only when typed in full), masked addresses, and a cap on
  // how fast anyone can search - so nobody can page through everyone.
  router.get('/api/directory', (ctx) => {
    if (!app.auth.limiter.take(`directory:${ctx.user.id}`, 60, 300e3)) {
      throw fail(429, `That's a lot of searching - try again in ${app.auth.limiter.retryAfter(`directory:${ctx.user.id}`)} seconds`);
    }
    const q = String(ctx.query.q || '').trim().replace(/[%_\\]/g, '').slice(0, 80);
    if (q.length < 2) return [];
    const args = [`%${q}%`, `%${q}%`, `%${q}%`, normEmail(q)];
    let where = `u.active = 1 AND u.email IS NOT NULL
      AND (u.username LIKE ? OR u.display_name LIKE ? OR l.name LIKE ? OR u.email = ?)`;
    if (ctx.query.notInTeam) {
      // Only your own game: anyone else's would tell you who plays in it.
      const team = T.getTeam(db, id(ctx.query.notInTeam, 'game'));
      if (team.owner_id !== ctx.user.id) throw fail(403, "Only this game's organiser can do that");
      where += ' AND NOT EXISTS (SELECT 1 FROM team_members tm WHERE tm.team_id = ? AND tm.user_id = u.id)';
      args.push(team.id);
    }
    return db.all(`SELECT u.id, u.username, u.display_name, u.email, l.name AS location FROM users u
      LEFT JOIN locations l ON l.id = u.location_id WHERE ${where}
      ORDER BY COALESCE(NULLIF(u.display_name, ''), u.username) COLLATE NOCASE LIMIT 25`, ...args)
      .map((u) => ({ id: u.id, name: u.display_name || u.username, emailHint: maskEmail(u.email), location: u.location, me: u.id === ctx.user.id }));
  }, M);
};
