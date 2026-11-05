'use strict';
// A player inside one team: their child, what their Santa sent them, the
// public task board and the anonymous notes. Every handler re-derives the
// player's Santa/child from the matches table - nothing the browser sends
// decides who is whose Santa.
const { fail, text, link, id, optionalId, date, bool, nowIso, today, isDate } = require('../lib/util');
const T = require('../services/teams');

module.exports = function teamRoutes(router, app) {
  const { db } = app;

  function member(ctx) {
    const team = T.getTeam(db, id(ctx.params.teamId, 'team'));
    if (!db.get('SELECT 1 FROM team_members WHERE team_id = ? AND user_id = ?', team.id, ctx.user.id)) {
      throw fail(403, 'You are not playing in this team');
    }
    const matched = T.matchCount(db, team.id) > 0;
    return { team, matched, phase: T.phaseOf(team, matched) };
  }

  function asSanta(ctx) {
    const m = member(ctx);
    const childId = T.childOf(db, m.team.id, ctx.user.id);
    if (!childId) throw fail(409, "You don't have a child in this team yet - names haven't been drawn");
    return { ...m, childId };
  }

  function requireLive(m, what) {
    if (m.phase === 'drawn') throw fail(409, `${what} opens on ${m.team.start_date}, when the game starts`);
    if (m.phase === 'ended') throw fail(409, `This game ended on ${m.team.end_date} - ${what.toLowerCase()} is closed`);
  }

  const view = (ctx, team) => T.memberView(db, team, ctx.user.id);

  router.get('/api/teams/:teamId', (ctx) => view(ctx, member(ctx).team));

  // Phase 1, check in: say (or confirm) where you play from. Open until the
  // location deadline and the draw, whichever comes first.
  router.put('/api/teams/:teamId/location', (ctx) => {
    const m = member(ctx);
    if (m.matched) throw fail(409, 'Names have been drawn - ask your organiser if your location changed');
    if (!T.checkInOpen(m.team, m.matched)) throw fail(409, `Check-in closed on ${m.team.location_deadline} - ask your organiser if your location changed`);
    const row = db.get('SELECT opted_out FROM team_members WHERE team_id = ? AND user_id = ?', m.team.id, ctx.user.id);
    if (row.opted_out) throw fail(409, "You're sitting this one out - count yourself back in first");
    const loc = optionalId(ctx.body.locationId, 'Location');
    if (loc && !db.get('SELECT 1 FROM locations WHERE id = ?', loc)) throw fail(400, 'Unknown location');
    const resolved = loc || db.get('SELECT location_id FROM users WHERE id = ?', ctx.user.id).location_id;
    if (!resolved) throw fail(400, "Pick where you're playing from");
    db.run('UPDATE team_members SET location_id = ?, location_confirmed_at = ? WHERE team_id = ? AND user_id = ?', loc, nowIso(), m.team.id, ctx.user.id);
    return view(ctx, m.team);
  });

  // Not up for it this year? Sit this game out (or come back) - only before
  // names are drawn; afterwards the organiser takes someone out of the circle.
  router.post('/api/teams/:teamId/sit-out', (ctx) => {
    const m = member(ctx);
    if (m.matched) throw fail(409, 'Names have already been drawn - have a quiet word with your organiser and they will sort it out');
    const out = ctx.body.out === undefined ? true : bool(ctx.body.out);
    db.run('UPDATE team_members SET opted_out = ?, opted_out_at = ? WHERE team_id = ? AND user_id = ?', out ? 1 : 0, out ? nowIso() : null, m.team.id, ctx.user.id);
    app.audit(ctx, out ? 'is sitting a game out' : 'is back in a game', m.team.name);
    return view(ctx, m.team);
  });

  // ---- gifts (Santa logs them; child marks received) ---------------------------
  const giftFields = (b) => ({
    description: text(b.description, { field: 'Gift', max: 300, required: true }),
    url: link(b.url),
    givenOn: date(b.givenOn, 'Date') || today(),
    isFinal: bool(b.isFinal) ? 1 : 0,
  });

  function ownGift(ctx, m) {
    const g = db.get('SELECT * FROM gifts WHERE id = ? AND team_id = ? AND santa_id = ?', id(ctx.params.giftId), m.team.id, ctx.user.id);
    if (!g) throw fail(404, 'That gift is not one of yours');
    return g;
  }

  router.post('/api/teams/:teamId/gifts', (ctx) => {
    const m = asSanta(ctx);
    requireLive(m, 'Gift giving');
    const f = giftFields(ctx.body);
    if (db.get('SELECT COUNT(*) AS n FROM gifts WHERE team_id = ? AND santa_id = ?', m.team.id, ctx.user.id).n >= 100) throw fail(400, 'That is a lot of gifts! The limit is 100.');
    const at = nowIso();
    const giftId = db.tx(() => {
      if (f.isFinal) db.run('UPDATE gifts SET is_final = 0 WHERE team_id = ? AND santa_id = ? AND child_id = ?', m.team.id, ctx.user.id, m.childId);
      return db.run(`INSERT INTO gifts (team_id, santa_id, child_id, description, url, given_on, is_final, created_at, updated_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, m.team.id, ctx.user.id, m.childId, f.description, f.url, f.givenOn, f.isFinal, at, at).lastInsertRowid;
    });
    app.notify.giftLogged(m.team, db.get('SELECT * FROM gifts WHERE id = ?', giftId));
    return view(ctx, m.team);
  });

  router.put('/api/teams/:teamId/gifts/:giftId', (ctx) => {
    const m = asSanta(ctx);
    const g = ownGift(ctx, m);
    const f = giftFields(ctx.body);
    db.tx(() => {
      if (f.isFinal) db.run('UPDATE gifts SET is_final = 0 WHERE team_id = ? AND santa_id = ? AND child_id = ?', m.team.id, ctx.user.id, g.child_id);
      db.run('UPDATE gifts SET description = ?, url = ?, given_on = ?, is_final = ?, updated_at = ? WHERE id = ?', f.description, f.url, f.givenOn, f.isFinal, nowIso(), g.id);
    });
    return view(ctx, m.team);
  });

  router.delete('/api/teams/:teamId/gifts/:giftId', (ctx) => {
    const m = member(ctx);
    const g = ownGift(ctx, m);
    if (g.received_at) throw fail(409, 'Your child has already marked this gift received');
    db.run('DELETE FROM gifts WHERE id = ?', g.id);
    return view(ctx, m.team);
  });

  router.post('/api/teams/:teamId/gifts/:giftId/received', (ctx) => {
    const m = member(ctx);
    const g = db.get('SELECT * FROM gifts WHERE id = ? AND team_id = ? AND child_id = ?', id(ctx.params.giftId), m.team.id, ctx.user.id);
    if (!g) throw fail(404, 'That gift was not for you');
    const received = ctx.body.received === undefined ? true : bool(ctx.body.received);
    const thanks = text(ctx.body.thanks, { field: 'Thank-you note', max: 500, multiline: true });
    db.run('UPDATE gifts SET received_at = ?, thanks = ?, updated_at = ? WHERE id = ?', received ? (g.received_at || nowIso()) : null, received ? thanks : '', nowIso(), g.id);
    return view(ctx, m.team);
  });

  // ---- fun tasks (Santa sets them, child does them, everyone sees them) ----
  const taskFields = (b, team) => {
    const dueDate = date(b.dueDate, 'Due date');
    if (dueDate && isDate(team.end_date) && dueDate > team.end_date) throw fail(400, `Pick a due date on or before ${team.end_date}, when the game ends`);
    return {
      title: text(b.title, { field: 'Task', max: 160, required: true }),
      details: text(b.details, { field: 'Details', max: 1000, multiline: true }),
      dueDate,
    };
  };

  function ownTask(ctx, m) {
    const t = db.get('SELECT * FROM tasks WHERE id = ? AND team_id = ? AND santa_id = ?', id(ctx.params.taskId), m.team.id, ctx.user.id);
    if (!t) throw fail(404, 'That task is not one of yours');
    return t;
  }

  router.post('/api/teams/:teamId/tasks', (ctx) => {
    const m = asSanta(ctx);
    requireLive(m, 'Setting tasks');
    const f = taskFields(ctx.body, m.team);
    if (db.get("SELECT COUNT(*) AS n FROM tasks WHERE team_id = ? AND santa_id = ? AND child_id = ? AND status = 'open'", m.team.id, ctx.user.id, m.childId).n >= 10) {
      throw fail(400, 'Your child already has 10 open tasks - let them catch their breath!');
    }
    const at = nowIso();
    const taskId = db.run(`INSERT INTO tasks (team_id, santa_id, child_id, title, details, due_date, created_at, updated_at)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, m.team.id, ctx.user.id, m.childId, f.title, f.details, f.dueDate, at, at).lastInsertRowid;
    app.notify.taskAssigned(m.team, db.get('SELECT * FROM tasks WHERE id = ?', taskId));
    return view(ctx, m.team);
  });

  router.put('/api/teams/:teamId/tasks/:taskId', (ctx) => {
    const m = asSanta(ctx);
    const t = ownTask(ctx, m);
    const f = taskFields(ctx.body, m.team);
    db.run('UPDATE tasks SET title = ?, details = ?, due_date = ?, updated_at = ? WHERE id = ?', f.title, f.details, f.dueDate, nowIso(), t.id);
    return view(ctx, m.team);
  });

  router.delete('/api/teams/:teamId/tasks/:taskId', (ctx) => {
    const m = member(ctx);
    const t = ownTask(ctx, m);
    db.run('DELETE FROM tasks WHERE id = ?', t.id);
    return view(ctx, m.team);
  });

  router.post('/api/teams/:teamId/tasks/:taskId/done', (ctx) => {
    const m = member(ctx);
    const t = db.get('SELECT * FROM tasks WHERE id = ? AND team_id = ? AND child_id = ?', id(ctx.params.taskId), m.team.id, ctx.user.id);
    if (!t) throw fail(404, 'That task was not set for you');
    const done = ctx.body.done === undefined ? true : bool(ctx.body.done);
    const note = text(ctx.body.note, { field: 'Note', max: 500, multiline: true });
    db.run('UPDATE tasks SET status = ?, done_note = ?, done_at = ?, updated_at = ? WHERE id = ?',
      done ? 'done' : 'open', done ? note : '', done ? nowIso() : null, nowIso(), t.id);
    return view(ctx, m.team);
  });

  router.post('/api/teams/:teamId/tasks/:taskId/cheer', (ctx) => {
    const m = member(ctx);
    const t = db.get('SELECT id FROM tasks WHERE id = ? AND team_id = ?', id(ctx.params.taskId), m.team.id);
    if (!t) throw fail(404, 'No such task');
    const removed = db.run('DELETE FROM task_cheers WHERE task_id = ? AND user_id = ?', t.id, ctx.user.id).changes;
    if (!removed) db.run('INSERT INTO task_cheers (task_id, user_id, created_at) VALUES (?, ?, ?)', t.id, ctx.user.id, nowIso());
    return T.board(db, m.team.id, ctx.user.id);
  });

  router.get('/api/teams/:teamId/board', (ctx) => {
    const m = member(ctx);
    return T.board(db, m.team.id, ctx.user.id);
  });

  // ---- anonymous notes ------------------------------------------------------------
  // side "child": I am the Santa writing to my child. side "santa": I am the
  // child writing to my (unknown) Santa.
  function pairFor(ctx, m) {
    const side = ctx.params.side;
    if (side === 'child') {
      const childId = T.childOf(db, m.team.id, ctx.user.id);
      if (!childId) throw fail(409, 'Names have not been drawn yet');
      return { santaId: ctx.user.id, childId, iAmSanta: true };
    }
    if (side === 'santa') {
      const santaId = T.santaOf(db, m.team.id, ctx.user.id);
      if (!santaId) throw fail(409, 'Names have not been drawn yet');
      return { santaId, childId: ctx.user.id, iAmSanta: false };
    }
    throw fail(404, 'Not found');
  }

  const thread = (m, pair) => db.all('SELECT id, from_santa, body, created_at FROM messages WHERE team_id = ? AND santa_id = ? AND child_id = ? ORDER BY id',
    m.team.id, pair.santaId, pair.childId).map((r) => ({
    id: r.id,
    mine: Boolean(r.from_santa) === pair.iAmSanta,
    body: r.body,
    createdAt: r.created_at,
  }));

  router.get('/api/teams/:teamId/messages/:side', (ctx) => {
    const m = member(ctx);
    const pair = pairFor(ctx, m);
    db.run('UPDATE messages SET read_at = ? WHERE team_id = ? AND santa_id = ? AND child_id = ? AND from_santa = ? AND read_at IS NULL',
      nowIso(), m.team.id, pair.santaId, pair.childId, pair.iAmSanta ? 0 : 1);
    return thread(m, pair);
  });

  router.post('/api/teams/:teamId/messages/:side', (ctx) => {
    const m = member(ctx);
    const pair = pairFor(ctx, m);
    if (m.phase === 'ended') throw fail(409, 'This game has ended - notes are closed');
    const body = text(ctx.body.body, { field: 'Note', max: 1000, multiline: true, required: true });
    app.auth.limit(`msg:${ctx.user.id}`, 30, 3600e3, 'That is a lot of notes - give the elves a rest and try again later');
    const msgId = db.run('INSERT INTO messages (team_id, santa_id, child_id, from_santa, body, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      m.team.id, pair.santaId, pair.childId, pair.iAmSanta ? 1 : 0, body, nowIso()).lastInsertRowid;
    app.notify.message(m.team, db.get('SELECT * FROM messages WHERE id = ?', msgId));
    return thread(m, pair);
  });
};
