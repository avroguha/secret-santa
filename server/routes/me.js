'use strict';
// The signed-in player: profile and hints, wishlist, their teams.
const { fail, text, link, id, optionalId, int, bool, nowIso, today } = require('../lib/util');
const T = require('../services/teams');

module.exports = function meRoutes(router, app) {
  const { db } = app;

  const profile = (userId) => {
    const u = db.get('SELECT u.*, l.name AS location_name FROM users u LEFT JOIN locations l ON l.id = u.location_id WHERE u.id = ?', userId);
    return {
      ...app.auth.publicUser(u),
      externalId: u.external_id,
      locationName: u.location_name,
      hints: T.parseHints(u.hints),
      dnd: Boolean(u.dnd),
    };
  };

  router.get('/api/me', (ctx) => profile(ctx.user.id));

  router.put('/api/me', (ctx) => {
    const b = ctx.body;
    const sets = [];
    const args = [];
    if (b.displayName !== undefined) {
      sets.push('display_name = ?');
      args.push(text(b.displayName, { field: 'Display name', max: 120 }));
    }
    if (b.locationId !== undefined) {
      const loc = optionalId(b.locationId, 'Location');
      if (loc && !db.get('SELECT 1 FROM locations WHERE id = ?', loc)) throw fail(400, 'Unknown location');
      sets.push('location_id = ?');
      args.push(loc);
    }
    // Do not disturb: no emails at all, except a sign-in code you ask for.
    if (b.dnd !== undefined) {
      sets.push('dnd = ?');
      args.push(b.dnd === true || b.dnd === 'true' || b.dnd === 1 ? 1 : 0);
    }
    if (b.hints !== undefined) {
      const hints = {};
      for (const k of T.HINT_KEYS) hints[k] = text(b.hints && b.hints[k], { field: k, max: 500, multiline: k === 'note' });
      sets.push('hints = ?');
      args.push(JSON.stringify(hints));
    }
    if (sets.length) db.run(`UPDATE users SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, ...args, nowIso(), ctx.user.id);
    return profile(ctx.user.id);
  });

  router.get('/api/locations', () => db.all('SELECT id, name FROM locations ORDER BY name COLLATE NOCASE'));

  // ---- wishlist ---------------------------------------------------------------
  const wishFields = (b) => ({
    title: text(b.title, { field: 'Wish', max: 160, required: true }),
    url: link(b.url),
    notes: text(b.notes, { field: 'Notes', max: 1000, multiline: true }),
    priority: int(b.priority, 'Priority', { min: 1, max: 3, fallback: 2 }),
  });

  router.get('/api/me/wishlist', (ctx) => T.wishlist(db, ctx.user.id));

  router.post('/api/me/wishlist', (ctx) => {
    if (db.get('SELECT COUNT(*) AS n FROM wishlist_items WHERE user_id = ?', ctx.user.id).n >= 50) throw fail(400, 'Fifty wishes is the limit - even Santa has a sack size');
    const w = wishFields(ctx.body);
    const at = nowIso();
    db.run('INSERT INTO wishlist_items (user_id, title, url, notes, priority, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ctx.user.id, w.title, w.url, w.notes, w.priority, at, at);
    return T.wishlist(db, ctx.user.id);
  });

  router.put('/api/me/wishlist/:itemId', (ctx) => {
    const w = wishFields(ctx.body);
    const r = db.run('UPDATE wishlist_items SET title = ?, url = ?, notes = ?, priority = ?, updated_at = ? WHERE id = ? AND user_id = ?',
      w.title, w.url, w.notes, w.priority, nowIso(), id(ctx.params.itemId), ctx.user.id);
    if (!r.changes) throw fail(404, 'That wish is not on your list');
    return T.wishlist(db, ctx.user.id);
  });

  router.delete('/api/me/wishlist/:itemId', (ctx) => {
    const r = db.run('DELETE FROM wishlist_items WHERE id = ? AND user_id = ?', id(ctx.params.itemId), ctx.user.id);
    if (!r.changes) throw fail(404, 'That wish is not on your list');
    return T.wishlist(db, ctx.user.id);
  });

  // ---- my teams -------------------------------------------------------------------
  router.get('/api/me/teams', (ctx) => {
    const day = today();
    const mine = db.all('SELECT t.* FROM teams t JOIN team_members tm ON tm.team_id = t.id WHERE tm.user_id = ? ORDER BY t.start_date DESC, t.name', ctx.user.id)
      .map((t) => {
        const matched = T.matchCount(db, t.id) > 0;
        const childId = T.childOf(db, t.id, ctx.user.id);
        const santaId = T.santaOf(db, t.id, ctx.user.id);
        const unread = db.get(`SELECT COUNT(*) AS n FROM messages WHERE team_id = ? AND read_at IS NULL
          AND ((child_id = ? AND from_santa = 1) OR (santa_id = ? AND from_santa = 0))`, t.id, ctx.user.id, ctx.user.id).n;
        const openTasks = db.get("SELECT COUNT(*) AS n FROM tasks WHERE team_id = ? AND child_id = ? AND status = 'open'", t.id, ctx.user.id).n;
        const revealed = matched && T.isRevealed(t, day);
        const mine = db.get('SELECT opted_out, location_confirmed_at, accepted_at FROM team_members WHERE team_id = ? AND user_id = ?', t.id, ctx.user.id);
        const checkInOpen = T.checkInOpen(t, matched, day);
        return T.publicTeam(t, {
          phase: T.phaseOf(t, matched, day),
          revealed,
          optedOut: Boolean(mine.opted_out),
          checkInOpen,
          needsCheckIn: checkInOpen && !mine.opted_out && !mine.location_confirmed_at,
          saidYes: Boolean(mine.accepted_at) && !mine.opted_out,
          memberCount: db.get('SELECT COUNT(*) AS n FROM team_members WHERE team_id = ? AND opted_out = 0', t.id).n,
          childName: childId ? T.userName(db, childId) : null,
          santaName: revealed && santaId ? T.userName(db, santaId) : null,
          unread,
          openTasks,
        });
      });
    const joinable = db.all(`SELECT t.* FROM teams t WHERE t.join_open = 1 AND t.drawn_at IS NULL AND t.end_date >= ?
        AND NOT EXISTS (SELECT 1 FROM team_members tm WHERE tm.team_id = t.id AND tm.user_id = ?) ORDER BY t.start_date`, day, ctx.user.id)
      .filter((t) => T.matchCount(db, t.id) === 0)
      .map((t) => T.publicTeam(t, { memberCount: db.get('SELECT COUNT(*) AS n FROM team_members WHERE team_id = ?', t.id).n }));
    // Games I organise (whether or not I play in them), with anything that needs my attention.
    const organising = db.all('SELECT * FROM teams WHERE owner_id = ? ORDER BY start_date DESC, name', ctx.user.id).map((t) => {
      const s = T.summary(db, t, day);
      return { ...s, warnings: T.ownerWarnings(s, day) };
    });
    for (const t of mine) t.isOwner = organising.some((o) => o.id === t.id);
    return { teams: mine, organising, joinable };
  });

  // Joining a game: from the open sign-up list, or with an invite code.
  function join(ctx, team) {
    if (T.matchCount(db, team.id) > 0) throw fail(409, 'Names have already been drawn for this game - ask the organiser to slot you in');
    if (team.end_date < today()) throw fail(409, 'This game is over');
    if (team.owner_id === ctx.user.id && !team.owner_ack_at) {
      if (!bool(ctx.body.ownerAck)) {
        throw fail(409, 'As the organiser you can see the whole Santa list - including who YOUR Santa is. Tick the box to say that is fine.', { code: 'owner_ack' });
      }
      db.run('UPDATE teams SET owner_ack_at = ? WHERE id = ?', nowIso(), team.id);
    }
    const loc = optionalId(ctx.body.locationId, 'Location');
    if (loc && !db.get('SELECT 1 FROM locations WHERE id = ?', loc)) throw fail(400, 'Unknown location');
    // Picking a location while joining is checking in.
    const resolved = loc || db.get('SELECT location_id FROM users WHERE id = ?', ctx.user.id).location_id;
    const added = db.run('INSERT OR IGNORE INTO team_members (team_id, user_id, location_id, location_confirmed_at, joined_at) VALUES (?, ?, ?, ?, ?)',
      team.id, ctx.user.id, loc, resolved ? nowIso() : null, nowIso()).changes;
    T.sayYes(db, team.id, ctx.user.id); // joining yourself is saying yes (also when you were added first)
    if (added) app.audit(ctx, 'joined a game', team.name);
    return { ok: true, id: team.id };
  }

  router.post('/api/teams/:teamId/join', (ctx) => {
    const team = T.getTeam(db, id(ctx.params.teamId));
    if (!team.join_open) throw fail(403, 'This game is invite-only - ask the organiser for the invite link');
    return join(ctx, team);
  });

  const byCode = (code) => {
    const c = String(code || '').trim().toLowerCase().replace(/^.*\/join\//, '').replace(/[^a-z0-9]/g, '');
    const t = c.length >= 6 ? db.get('SELECT * FROM teams WHERE invite_code = ?', c) : null;
    if (!t) throw fail(404, "That invite code doesn't match any game - check it with the organiser");
    return t;
  };

  router.get('/api/join/:code', (ctx) => {
    const t = byCode(ctx.params.code);
    const s = T.summary(db, t);
    const member = db.get('SELECT 1 FROM team_members WHERE team_id = ? AND user_id = ?', t.id, ctx.user.id);
    const matched = T.matchCount(db, t.id) > 0;
    return {
      team: T.publicTeam(t, { memberCount: s.memberCount, phase: s.phase, organiser: s.owner ? s.owner.name : null }),
      alreadyIn: Boolean(member),
      isOwner: t.owner_id === ctx.user.id,
      ownerAccepted: Boolean(t.owner_ack_at),
      canJoin: !member && !matched && t.end_date >= today(),
      reason: member ? '' : matched ? 'Names have already been drawn - ask the organiser to slot you in.' : t.end_date < today() ? 'This game is over.' : '',
    };
  });

  router.post('/api/join/:code', (ctx) => join(ctx, byCode(ctx.params.code)));

  // "How to play": the organiser's guidelines, plus each of my teams' own rules.
  router.get('/api/guide', (ctx) => ({
    text: app.settings.read('guidelines').text,
    teams: db.all(`SELECT t.* FROM teams t JOIN team_members tm ON tm.team_id = t.id
                    WHERE tm.user_id = ? ORDER BY t.start_date DESC`, ctx.user.id)
      .map((t) => ({ id: t.id, name: t.name, guidelines: t.guidelines, startDate: t.start_date, endDate: t.end_date, locationDeadline: t.location_deadline, budget: t.budget })),
  }));

  router.post('/api/teams/:teamId/leave', (ctx) => {
    const team = T.getTeam(db, id(ctx.params.teamId));
    if (T.matchCount(db, team.id) > 0) throw fail(409, 'Names have been drawn - have a word with the organiser if you need to drop out');
    db.run('DELETE FROM team_members WHERE team_id = ? AND user_id = ?', team.id, ctx.user.id);
    app.audit(ctx, 'left a team', team.name);
    return { ok: true };
  });
};
