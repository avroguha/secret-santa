'use strict';
// SQLite through Node's built-in driver (node:sqlite): no native module to
// compile, nothing extra to vet. One process owns the file; WAL keeps reads
// from blocking the writer.
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA_V1 = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE locations (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  created_at TEXT NOT NULL
);

CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  external_id TEXT UNIQUE COLLATE NOCASE,
  username TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  email TEXT UNIQUE COLLATE NOCASE,
  location_id INTEGER REFERENCES locations(id) ON DELETE SET NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  password_hash TEXT,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  hints TEXT NOT NULL DEFAULT '{}',
  source TEXT NOT NULL DEFAULT 'manual',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_login_at TEXT
);
CREATE UNIQUE INDEX users_local_login ON users(username COLLATE NOCASE) WHERE password_hash IS NOT NULL;

CREATE TABLE teams (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  description TEXT NOT NULL DEFAULT '',
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  budget TEXT NOT NULL DEFAULT '',
  match_scope TEXT NOT NULL DEFAULT 'location' CHECK (match_scope IN ('location', 'all')),
  min_group_size INTEGER NOT NULL DEFAULT 3,
  reveal_mode TEXT NOT NULL DEFAULT 'after_end' CHECK (reveal_mode IN ('after_end', 'manual')),
  revealed INTEGER NOT NULL DEFAULT 0,
  join_open INTEGER NOT NULL DEFAULT 0,
  drawn_at TEXT,
  draw_count INTEGER NOT NULL DEFAULT 0,
  start_notified INTEGER NOT NULL DEFAULT 0,
  reveal_notified INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- location_id: where this person plays from in THIS team (NULL = their profile location).
-- pool_location_id: an admin adjustment - match them with that location's pool instead.
CREATE TABLE team_members (
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  location_id INTEGER REFERENCES locations(id) ON DELETE SET NULL,
  pool_location_id INTEGER REFERENCES locations(id) ON DELETE SET NULL,
  joined_at TEXT NOT NULL,
  PRIMARY KEY (team_id, user_id)
);
CREATE INDEX team_members_user ON team_members(user_id);

-- Neither of the pair may draw the other.
CREATE TABLE exclusions (
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_a INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (team_id, user_a, user_b),
  CHECK (user_a < user_b)
);

CREATE TABLE matches (
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  santa_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  child_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (team_id, santa_id),
  UNIQUE (team_id, child_id),
  CHECK (santa_id <> child_id)
);

CREATE TABLE wishlist_items (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  url TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  priority INTEGER NOT NULL DEFAULT 2 CHECK (priority BETWEEN 1 AND 3),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX wishlist_user ON wishlist_items(user_id);

CREATE TABLE gifts (
  id INTEGER PRIMARY KEY,
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  santa_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  child_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  url TEXT NOT NULL DEFAULT '',
  given_on TEXT NOT NULL,
  is_final INTEGER NOT NULL DEFAULT 0,
  received_at TEXT,
  thanks TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX gifts_team_child ON gifts(team_id, child_id);
CREATE INDEX gifts_team_santa ON gifts(team_id, santa_id);

CREATE TABLE tasks (
  id INTEGER PRIMARY KEY,
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  santa_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  child_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  due_date TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
  done_note TEXT NOT NULL DEFAULT '',
  done_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX tasks_team ON tasks(team_id);

CREATE TABLE task_cheers (
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (task_id, user_id)
);

-- Anonymous notes between a Santa and their child. from_santa says who wrote it;
-- the child's side of the API never learns santa_id.
CREATE TABLE messages (
  id INTEGER PRIMARY KEY,
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  santa_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  child_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  from_santa INTEGER NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  read_at TEXT
);
CREATE INDEX messages_pair ON messages(team_id, santa_id, child_id);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  method TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  ip TEXT NOT NULL DEFAULT '',
  user_agent TEXT NOT NULL DEFAULT ''
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE otp_codes (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL COLLATE NOCASE,
  code_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);
CREATE INDEX otp_email ON otp_codes(email);

CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

-- Every email the app writes: the send queue and the log in one.
CREATE TABLE outbox (
  id INTEGER PRIMARY KEY,
  to_email TEXT NOT NULL,
  to_name TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL,
  html TEXT NOT NULL,
  text TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'sent', 'failed', 'captured')),
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  sent_at TEXT
);
CREATE INDEX outbox_status ON outbox(status);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY,
  actor_id INTEGER,
  actor_name TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
`;

// v2: the check-in phase (location deadline and who has confirmed), sitting a
// game out, Do Not Disturb, guidelines, and a record of automatic reminders.
const SCHEMA_V2 = `
ALTER TABLE users ADD COLUMN dnd INTEGER NOT NULL DEFAULT 0;
ALTER TABLE team_members ADD COLUMN opted_out INTEGER NOT NULL DEFAULT 0;
ALTER TABLE team_members ADD COLUMN opted_out_at TEXT;
ALTER TABLE team_members ADD COLUMN location_confirmed_at TEXT;
ALTER TABLE teams ADD COLUMN location_deadline TEXT;
ALTER TABLE teams ADD COLUMN reminder_days TEXT NOT NULL DEFAULT '3,1';
ALTER TABLE teams ADD COLUMN guidelines TEXT NOT NULL DEFAULT '';

-- One row per automatic reminder round, so a round is never sent twice.
CREATE TABLE reminders_sent (
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('location', 'gift')),
  offset_days INTEGER NOT NULL,
  sent_at TEXT NOT NULL,
  recipients INTEGER NOT NULL DEFAULT 0,
  manual INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (team_id, kind, offset_days)
);
`;

// v3: games belong to the person who created them (owner), who can share an
// invite code, and who may play in their own game only after accepting that
// they can see the whole Santa list (owner_ack_at). Existing games go to the
// first admin, who can hand them on.
const SCHEMA_V3 = `
ALTER TABLE teams ADD COLUMN owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE teams ADD COLUMN invite_code TEXT;
ALTER TABLE teams ADD COLUMN owner_ack_at TEXT;
UPDATE teams SET owner_id = (SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1) WHERE owner_id IS NULL;
UPDATE teams SET invite_code = lower(hex(randomblob(5))) WHERE invite_code IS NULL;
CREATE UNIQUE INDEX teams_invite_code ON teams(invite_code);
CREATE INDEX teams_owner ON teams(owner_id);
`;

// v4: "said yes". Anyone can create a game and add anyone to it, so being
// added is not consent: a child's wishlist and hints reach their Santa only
// once the child has said yes to that game (joined by invite or sign-up,
// checked in, counted themselves in, or plays as its organiser).
const SCHEMA_V4 = `
ALTER TABLE team_members ADD COLUMN accepted_at TEXT;
UPDATE team_members SET accepted_at = location_confirmed_at WHERE location_confirmed_at IS NOT NULL AND opted_out = 0;
UPDATE team_members SET accepted_at = joined_at
 WHERE accepted_at IS NULL
   AND user_id = (SELECT owner_id FROM teams t WHERE t.id = team_members.team_id)
   AND (SELECT owner_ack_at FROM teams t WHERE t.id = team_members.team_id) IS NOT NULL;
`;

const MIGRATIONS = [SCHEMA_V1, SCHEMA_V2, SCHEMA_V3, SCHEMA_V4];

function wrap(raw) {
  const cache = new Map();
  const prep = (sql) => {
    let st = cache.get(sql);
    if (!st) {
      st = raw.prepare(sql);
      cache.set(sql, st);
    }
    return st;
  };
  let depth = 0;
  const db = {
    raw,
    all: (sql, ...p) => prep(sql).all(...p),
    get: (sql, ...p) => prep(sql).get(...p),
    run: (sql, ...p) => prep(sql).run(...p),
    exec: (sql) => raw.exec(sql),
    // Nested calls join the outer transaction.
    tx(fn) {
      if (depth > 0) return fn();
      depth += 1;
      raw.exec('BEGIN IMMEDIATE');
      try {
        const out = fn();
        raw.exec('COMMIT');
        return out;
      } catch (err) {
        try { raw.exec('ROLLBACK'); } catch { /* already rolled back */ }
        throw err;
      } finally {
        depth -= 1;
      }
    },
    close: () => raw.close(),
  };
  return db;
}

function migrate(db) {
  const current = Number(db.get('PRAGMA user_version').user_version || 0);
  for (let v = current; v < MIGRATIONS.length; v += 1) {
    db.tx(() => {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
  return current;
}

function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const raw = new DatabaseSync(file);
  raw.exec('PRAGMA journal_mode = WAL');
  raw.exec('PRAGMA foreign_keys = ON');
  raw.exec('PRAGMA busy_timeout = 5000');
  const db = wrap(raw);
  db.previousVersion = migrate(db);
  return db;
}

module.exports = { openDb, MIGRATIONS };
