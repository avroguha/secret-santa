'use strict';
// People: CSV import (userName, ID, email - plus an optional location),
// manual edits, and deleting someone without breaking a drawn circle.
const { parseCsv } = require('../lib/csv');
const { fail, nowIso, normEmail, isEmail, text } = require('../lib/util');
const T = require('./teams');

// Header names people actually use, normalised to lower case letters only.
const COLUMNS = {
  username: ['username', 'user', 'name', 'fullname', 'employeename', 'personname'],
  displayName: ['displayname', 'preferredname', 'nickname', 'knownas'],
  externalId: ['id', 'userid', 'employeeid', 'empid', 'staffid', 'corpid', 'personid', 'employeenumber', 'empno'],
  email: ['email', 'emailaddress', 'mail', 'emailid', 'workemail'],
  location: ['location', 'office', 'site', 'city', 'baselocation', 'playingfrom'],
};

const normHeader = (h) => String(h || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function mapHeader(header) {
  const map = {};
  header.forEach((h, i) => {
    const n = normHeader(h);
    for (const [field, aliases] of Object.entries(COLUMNS)) {
      if (map[field] === undefined && aliases.includes(n)) map[field] = i;
    }
  });
  return map;
}

function plan(db, csvText, { createLocations = true } = {}) {
  const rows = parseCsv(csvText);
  if (!rows.length) throw fail(400, 'The file is empty');
  if (rows.length > 20001) throw fail(400, 'At most 20,000 people per file');
  const header = rows[0];
  const map = mapHeader(header);
  const missing = ['username', 'externalId', 'email'].filter((k) => map[k] === undefined);
  if (missing.length) {
    const names = { username: 'userName', externalId: 'ID', email: 'email' };
    throw fail(400, `The header row needs these columns: ${missing.map((m) => names[m]).join(', ')}. Found: ${header.join(', ') || '(nothing)'}`);
  }
  const locations = new Map(db.all('SELECT id, name FROM locations').map((l) => [l.name.toLowerCase(), l]));
  const seenIds = new Map();
  const seenEmails = new Map();
  const out = [];
  const newLocations = new Set();

  rows.slice(1).forEach((cells, idx) => {
    const line = idx + 2;
    const get = (k) => (map[k] === undefined ? '' : String(cells[map[k]] || '').trim());
    const r = {
      line,
      username: get('username').replace(/\s+/g, ' '),
      displayName: get('displayName').replace(/\s+/g, ' '),
      externalId: get('externalId'),
      email: normEmail(get('email')),
      location: get('location').replace(/\s+/g, ' '),
      errors: [],
      warnings: [],
    };
    if (!r.username) r.errors.push('userName is empty');
    if (r.username.length > 120) r.errors.push('userName is longer than 120 characters');
    if (!r.externalId) r.errors.push('ID is empty');
    if (r.externalId.length > 64) r.errors.push('ID is longer than 64 characters');
    if (!r.email) r.errors.push('email is empty');
    else if (!isEmail(r.email)) r.errors.push(`"${r.email}" is not an email address`);
    if (r.externalId) {
      const k = r.externalId.toLowerCase();
      if (seenIds.has(k)) r.errors.push(`ID ${r.externalId} is also on line ${seenIds.get(k)}`);
      else seenIds.set(k, line);
    }
    if (r.email) {
      if (seenEmails.has(r.email)) r.errors.push(`email is also on line ${seenEmails.get(r.email)}`);
      else seenEmails.set(r.email, line);
    }
    if (r.location && r.location.length > 80) r.errors.push('location is longer than 80 characters');
    if (r.location && !locations.has(r.location.toLowerCase())) {
      if (createLocations) newLocations.add(r.location);
      else r.warnings.push(`location "${r.location}" does not exist and will be left empty`);
    }

    if (!r.errors.length) {
      const byId = db.get('SELECT * FROM users WHERE external_id = ?', r.externalId);
      const byEmail = db.get('SELECT * FROM users WHERE email = ?', r.email);
      if (byId && byEmail && byId.id !== byEmail.id) {
        r.errors.push(`ID ${r.externalId} belongs to ${byId.username} but ${r.email} belongs to ${byEmail.username}`);
      } else {
        const existing = byId || byEmail;
        if (!existing) {
          r.action = 'create';
        } else {
          r.userId = existing.id;
          const loc = r.location ? locations.get(r.location.toLowerCase()) : null;
          const changed = existing.username !== r.username
            || (r.displayName && existing.display_name !== r.displayName)
            || (existing.external_id || '') !== r.externalId
            || (existing.email || '') !== r.email
            || (r.location && (!loc || loc.id !== existing.location_id))
            || !existing.active;
          r.action = changed ? 'update' : 'unchanged';
        }
      }
    }
    if (r.errors.length) r.action = 'error';
    out.push(r);
  });

  const count = (a) => out.filter((r) => r.action === a).length;
  return {
    columns: Object.fromEntries(Object.entries(map).map(([k, i]) => [k, header[i]])),
    rows: out,
    newLocations: [...newLocations],
    summary: { total: out.length, create: count('create'), update: count('update'), unchanged: count('unchanged'), error: count('error') },
  };
}

// Games are not touched: who plays where is each game owner's business.
function commit(db, csvText, { createLocations = true } = {}) {
  return db.tx(() => {
    const p = plan(db, csvText, { createLocations });
    const at = nowIso();
    for (const name of p.newLocations) db.run('INSERT OR IGNORE INTO locations (name, created_at) VALUES (?, ?)', name, at);
    const locations = new Map(db.all('SELECT id, name FROM locations').map((l) => [l.name.toLowerCase(), l.id]));
    for (const r of p.rows) {
      if (r.action === 'error') continue;
      const locId = r.location ? locations.get(r.location.toLowerCase()) || null : null;
      let uid = r.userId;
      if (r.action === 'create') {
        uid = db.run(
          `INSERT INTO users (external_id, username, display_name, email, location_id, source, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'csv', ?, ?)`,
          r.externalId, r.username, r.displayName, r.email, locId, at, at,
        ).lastInsertRowid;
      } else if (r.action === 'update') {
        db.run(
          `UPDATE users SET external_id = ?, username = ?, display_name = CASE WHEN ? <> '' THEN ? ELSE display_name END,
                  email = ?, location_id = COALESCE(?, location_id), active = 1, updated_at = ? WHERE id = ?`,
          r.externalId, r.username, r.displayName, r.displayName, r.email, locId, at, uid,
        );
      }
    }
    return {
      columns: p.columns,
      newLocations: p.newLocations,
      summary: p.summary,
      skipped: p.rows.filter((r) => r.action === 'error').map((r) => ({ line: r.line, errors: r.errors })),
    };
  });
}

// Remove someone everywhere, closing every circle they were part of first.
function deleteUser(db, userId) {
  return db.tx(() => {
    const notes = [];
    for (const { team_id: teamId } of db.all('SELECT team_id FROM team_members WHERE user_id = ?', userId)) {
      const team = T.getTeam(db, teamId);
      notes.push(...T.removeFromCircle(db, team, userId).notes.map((n) => `${team.name}: ${n}`));
    }
    db.run('DELETE FROM users WHERE id = ?', userId);
    return notes;
  });
}

function validateProfileFields(body, { requireEmail = true } = {}) {
  const username = text(body.username, { field: 'Name', max: 120, required: true });
  const displayName = text(body.displayName, { field: 'Display name', max: 120 });
  const externalId = text(body.externalId, { field: 'ID', max: 64 });
  const email = normEmail(body.email);
  if (requireEmail && !email) throw fail(400, 'Email is required');
  if (email && !isEmail(email)) throw fail(400, 'That email address is not valid');
  return { username, displayName, externalId: externalId || null, email: email || null };
}

module.exports = { plan, commit, deleteUser, mapHeader, validateProfileFields, COLUMNS };
