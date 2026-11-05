'use strict';
// Demo data: a handful of festive people, three teams in three different
// states, wishlists, gifts, tasks and notes - enough to click through every
// screen. It is written ONLY to the demo database (demo.sqlite); with demo
// mode off the app opens santa.sqlite instead and none of this exists there.
const T = require('./services/teams');
const { nowIso, today, addDays, hashPassword } = require('./lib/util');

const LOCATIONS = ['North Pole', 'Gingerbread Town', 'Candy Cane Lane', 'Snowglobe City'];

const PEOPLE = [
  ['Holly Berry', 'North Pole', { likes: 'Hot cocoa, cosy socks, true-crime podcasts', dislikes: 'Anything with coconut', hobbies: 'Baking, board games', colours: 'Forest green and gold', sizes: 'M, shoes UK 6', note: 'I collect snow globes!' }],
  ['Jack Frost', 'North Pole', { likes: 'Mint chocolate, sci-fi novels', dislikes: 'Scented candles', hobbies: 'Ice skating, photography', colours: 'Icy blue', sizes: 'L' }],
  ['Noelle Winters', 'North Pole', { likes: 'Puzzles, fancy tea', hobbies: 'Crochet', colours: 'Burgundy' }],
  ['Nick Kringle', 'North Pole', { likes: 'Coffee, vinyl records', dislikes: 'Socks (I have 200 pairs)', hobbies: 'Running' }],
  ['Ivy Evergreen', 'North Pole', { likes: 'Plants, plants, more plants', hobbies: 'Gardening, yoga', colours: 'Sage green' }],
  ['Rudy Rednose', 'North Pole', { likes: 'Spicy snacks, comic books', hobbies: 'Video games', sizes: 'XL' }],
  ['Dasher Dunn', 'North Pole', { likes: 'Gadgets', hobbies: 'Cycling' }],
  ['Carol Singer', 'Gingerbread Town', { likes: 'Karaoke, scented hand cream', hobbies: 'Choir', colours: 'Lilac' }],
  ['Buddy Elfson', 'Gingerbread Town', { likes: 'Syrup on everything, hugs', dislikes: 'Cotton-headed ninny muggins', hobbies: 'Decorating' }],
  ['Ginger Snap', 'Gingerbread Town', { likes: 'Cookies, cinnamon', hobbies: 'Pottery' }],
  ['Pepper Mintz', 'Gingerbread Town', { likes: 'Stationery, washi tape', hobbies: 'Journaling', colours: 'Mint' }],
  ['Joy Holiday', 'Gingerbread Town', { likes: 'Travel guides, maps', hobbies: 'Hiking' }],
  ['Tinsel Taylor', 'Gingerbread Town', { likes: 'Glitter (sorry)', hobbies: 'Dancing' }],
  ['Frost Snowden', 'Candy Cane Lane', { likes: 'Board games', hobbies: 'Chess' }],
  ['Star Bright', 'Candy Cane Lane', { likes: 'Astronomy, telescopes', hobbies: 'Stargazing', colours: 'Midnight blue' }],
  ['Angela Wing', 'Candy Cane Lane', { likes: 'Music', hobbies: 'Piano' }],
  ['Comet Starling', 'Snowglobe City', { likes: 'Hot sauce', hobbies: 'Rock climbing' }],
  ['Mistle Toe', null, { likes: 'Surprises!' }],
];

const WISHES = [
  ['Fuzzy reindeer socks', 'https://www.example.com/shop/reindeer-socks', 'Size M please - the sillier the better', 1],
  ['A good mystery novel', '', 'Agatha Christie style', 2],
  ['Mini succulent in a cute pot', 'https://www.example.com/shop/succulent', '', 2],
  ['Hot sauce sampler', 'https://www.example.com/shop/hot-sauce-trio', 'The hotter the better', 1],
  ['Desk snow globe', 'https://www.example.com/shop/snow-globe', 'For my collection!', 1],
  ['Gourmet hot chocolate', '', 'Dark chocolate, no marshmallows', 3],
  ['Pocket notebook', 'https://www.example.com/shop/notebook', 'Dotted pages', 2],
  ['Festive mug', 'https://www.example.com/shop/festive-mug', '', 3],
  ['Puzzle (500 pieces)', '', 'Anything wintery', 2],
  ['Lip balm set', '', '', 3],
];

const SMALL_GIFTS = [
  'A candy cane taped to your monitor', 'Hot cocoa sachets on your desk', 'A tiny potted succulent',
  'A reindeer antler headband', 'Festive sticky notes', 'A handwritten riddle card', 'A gingerbread cookie in a tin',
];
const FINAL_GIFTS = ['A cosy knitted scarf', 'A holiday board game', 'A personalised mug', 'A box of artisan chocolates', 'A snow globe with a tiny workshop inside'];
const TASKS = [
  ['Wear a festive hat to the next stand-up', 'Bonus points for jingle bells.'],
  ['Share your best holiday cookie recipe', 'Post it in the team chat with a photo.'],
  ['Hum a Christmas song until someone guesses it', ''],
  ['Decorate your desk with tinsel', 'Send a photo to the team chat.'],
  ['Tell the team your favourite holiday memory', ''],
  ['Do your best reindeer impression on the next call', 'Antlers optional, enthusiasm mandatory.'],
  ['Learn to say "Merry Christmas" in three languages', ''],
];

const pick = (list, i) => list[i % list.length];
const email = (name) => `${name.toLowerCase().replace(/[^a-z]+/g, '.')}@example.com`;

function wipe(db) {
  for (const t of ['task_cheers', 'tasks', 'gifts', 'messages', 'matches', 'exclusions', 'team_members', 'teams',
    'wishlist_items', 'sessions', 'otp_codes', 'users', 'locations', 'outbox', 'audit_log']) {
    db.run(`DELETE FROM ${t}`);
  }
}

function seed(app, { reset = false } = {}) {
  const { db } = app;
  const done = db.get("SELECT value FROM meta WHERE key = 'demo_seeded'");
  if (done && !reset) return false;
  const day = today();
  const at = nowIso();
  db.tx(() => {
    wipe(db);
    db.run("INSERT INTO users (username, display_name, role, password_hash, must_change_password, source, created_at, updated_at) VALUES ('admin', 'Head Elf (admin)', 'admin', ?, 0, 'seed', ?, ?)",
      hashPassword('admin'), at, at);
    const loc = {};
    for (const l of LOCATIONS) loc[l] = db.run('INSERT INTO locations (name, created_at) VALUES (?, ?)', l, at).lastInsertRowid;
    const uid = {};
    PEOPLE.forEach(([name, l, hints], i) => {
      uid[name] = db.run(`INSERT INTO users (external_id, username, email, location_id, role, hints, source, created_at, updated_at)
                          VALUES (?, ?, ?, ?, ?, ?, 'csv', ?, ?)`,
      `E${1001 + i}`, name, email(name), l ? loc[l] : null, name === 'Noelle Winters' ? 'admin' : 'user', JSON.stringify(hints), at, at).lastInsertRowid;
      const n = 2 + (i % 3);
      for (let w = 0; w < n; w += 1) {
        const [title, url, notes, priority] = pick(WISHES, i * 3 + w);
        db.run('INSERT INTO wishlist_items (user_id, title, url, notes, priority, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          uid[name], title, url, notes, priority, at, at);
      }
    });

    const team = (name, f) => db.run(`INSERT INTO teams (name, description, start_date, end_date, budget, match_scope, min_group_size, reveal_mode, revealed, join_open,
        location_deadline, reminder_days, guidelines, owner_id, invite_code, owner_ack_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, name, f.description, f.start, f.end, f.budget, f.scope || 'location', 3, f.reveal || 'after_end', f.revealed ? 1 : 0, f.joinOpen ? 1 : 0,
    f.checkIn || null, '3,1', f.guidelines || '', uid[f.owner], f.code, f.ownerPlays ? at : null, at, at).lastInsertRowid;
    // checkedIn: everyone has confirmed their location (games past phase 1).
    const join = (teamId, names, checkedIn = true) => names.forEach((n) => db.run('INSERT INTO team_members (team_id, user_id, location_confirmed_at, joined_at) VALUES (?, ?, ?, ?)', teamId, uid[n], checkedIn ? at : null, at));
    // Two people who asked for a quiet inbox.
    for (const n of ['Rudy Rednose', 'Frost Snowden']) db.run('UPDATE users SET dnd = 1 WHERE id = ?', uid[n]);

    // 1. A game in full swing, matched by location.
    const live = team('Workshop Elves', {
      description: 'Our office Secret Santa! Small surprises all month, one final gift at the party on the last day. 🎄',
      checkIn: addDays(day, -10),
      owner: 'Noelle Winters', ownerPlays: true, code: 'elves2026x',
      guidelines: '- Small surprises during the game: keep them under $5\n- The **final gift** is opened together at the party on the last day 🎉\n- Desk deliveries before 10am are extra magical ☕',
      start: addDays(day, -6), end: addDays(day, 14), budget: '$25 final gift, small treats welcome',
    });
    join(live, ['Holly Berry', 'Jack Frost', 'Noelle Winters', 'Nick Kringle', 'Ivy Evergreen', 'Rudy Rednose',
      'Carol Singer', 'Buddy Elfson', 'Ginger Snap', 'Pepper Mintz', 'Joy Holiday']);
    db.run('INSERT INTO exclusions (team_id, user_a, user_b, created_at) VALUES (?, ?, ?, ?)', live,
      Math.min(uid['Nick Kringle'], uid['Ivy Evergreen']), Math.max(uid['Nick Kringle'], uid['Ivy Evergreen']), at);
    T.draw(db, T.getTeam(db, live));
    const pairs = db.all('SELECT santa_id, child_id FROM matches WHERE team_id = ?', live);
    pairs.forEach((p, i) => {
      for (let g = 0; g < (i % 3); g += 1) {
        const received = g === 0 && i % 2 === 0;
        db.run(`INSERT INTO gifts (team_id, santa_id, child_id, description, given_on, received_at, thanks, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, live, p.santa_id, p.child_id, pick(SMALL_GIFTS, i + g), addDays(day, -5 + g * 2),
        received ? at : null, received ? 'Thank you, mystery Santa! Made my morning ☕' : '', at, at);
      }
      const [title, details] = pick(TASKS, i);
      const doneTask = i % 3 === 1;
      const taskId = db.run(`INSERT INTO tasks (team_id, santa_id, child_id, title, details, due_date, status, done_note, done_at, created_at, updated_at)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, live, p.santa_id, p.child_id, title, details, addDays(day, 3 + (i % 5)),
      doneTask ? 'done' : 'open', doneTask ? 'Done - the team loved it! 🎶' : '', doneTask ? at : null, at, at).lastInsertRowid;
      pairs.slice(0, i % 4).forEach((q) => db.run('INSERT OR IGNORE INTO task_cheers (task_id, user_id, created_at) VALUES (?, ?, ?)', taskId, q.santa_id, at));
      if (i < 4) {
        db.run('INSERT INTO messages (team_id, santa_id, child_id, from_santa, body, created_at) VALUES (?, ?, ?, 1, ?, ?)', live, p.santa_id, p.child_id, 'Quick question for my investigation: tea or coffee? ☕', at);
        db.run('INSERT INTO messages (team_id, santa_id, child_id, from_santa, body, created_at) VALUES (?, ?, ?, 0, ?, ?)', live, p.santa_id, p.child_id, 'Coffee, always! And no coconut please 😄', at);
      }
    });

    // 2. Still being set up: uneven locations, to show the highlighting and merging.
    const setup = team('Reindeer Games', {
      description: 'Cross-office game for the new year party. Names are drawn next week - add your wishes!',
      start: addDays(day, 10), end: addDays(day, 30), budget: '$30', joinOpen: true,
      checkIn: addDays(day, 3),
      owner: 'Holly Berry', ownerPlays: true, code: 'reindeer26',
      guidelines: '# Reindeer Games house rules\n- Check in by the date above so we can pair you up\n- Homemade gifts are **very** welcome\n- Not this year? Press *Sit this one out* - no hard feelings 💛',
    });
    join(setup, ['Holly Berry', 'Jack Frost', 'Dasher Dunn', 'Noelle Winters', 'Tinsel Taylor', 'Ginger Snap', 'Carol Singer',
      'Frost Snowden', 'Star Bright', 'Comet Starling', 'Mistle Toe'], false);
    // Phase 1 in progress: some have checked in, one is sitting this one out.
    for (const n of ['Holly Berry', 'Jack Frost', 'Noelle Winters', 'Tinsel Taylor', 'Ginger Snap', 'Frost Snowden']) {
      db.run('UPDATE team_members SET location_confirmed_at = ? WHERE team_id = ? AND user_id = ?', at, setup, uid[n]);
    }
    db.run('UPDATE team_members SET opted_out = 1, opted_out_at = ? WHERE team_id = ? AND user_id = ?', at, setup, uid['Dasher Dunn']);

    // 3. Last year's game, over and revealed.
    const past = team('Winter Wonderland 2025', {
      description: 'Last year’s game. Everyone across offices, matched together.',
      start: addDays(day, -345), end: addDays(day, -320), budget: '$20', scope: 'all', revealed: true,
      owner: 'Noelle Winters', code: 'winter2025',
    });
    join(past, ['Holly Berry', 'Jack Frost', 'Ivy Evergreen', 'Carol Singer', 'Buddy Elfson', 'Star Bright', 'Joy Holiday']);
    T.draw(db, T.getTeam(db, past));
    db.run('UPDATE teams SET revealed = 1, start_notified = 1, reveal_notified = 1 WHERE id = ?', past);
    db.all('SELECT santa_id, child_id FROM matches WHERE team_id = ?', past).forEach((p, i) => {
      db.run(`INSERT INTO gifts (team_id, santa_id, child_id, description, given_on, is_final, received_at, thanks, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`, past, p.santa_id, p.child_id, pick(FINAL_GIFTS, i), addDays(day, -320), at, 'Best gift ever! 🎁', at, at);
      const [title] = pick(TASKS, i + 2);
      db.run(`INSERT INTO tasks (team_id, santa_id, child_id, title, status, done_note, done_at, created_at, updated_at)
              VALUES (?, ?, ?, ?, 'done', 'Mission accomplished', ?, ?, ?)`, past, p.santa_id, p.child_id, title, at, at, at);
    });

    db.run("INSERT INTO meta (key, value) VALUES ('demo_seeded', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", at);
    db.run("INSERT INTO audit_log (actor_name, action, detail, created_at) VALUES ('system', 'loaded the demo data', '', ?)", at);
  });
  return true;
}

module.exports = { seed, LOCATIONS, PEOPLE };
