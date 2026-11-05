'use strict';
// Small shared helpers: dates, validation, crypto.
const crypto = require('node:crypto');

class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    if (details !== undefined) this.details = details;
  }
}
const fail = (status, message, details) => new HttpError(status, message, details);

const nowIso = () => new Date().toISOString();

// "Today" in the server's time zone (TZ in the env file). Game dates are plain
// calendar dates, so a team whose end date is 24 Dec plays through that day.
function today(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function isDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const dt = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(dt.getTime()) && dt.toISOString().slice(0, 10) === s;
}

const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]+$/;
const normEmail = (s) => String(s || '').trim().toLowerCase();
const isEmail = (s) => typeof s === 'string' && s.length <= 254 && EMAIL_RE.test(s);

// ---- request validation ---------------------------------------------------
function text(value, { field = 'value', max = 200, required = false, multiline = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw fail(400, `${field} is required`);
    return '';
  }
  if (typeof value !== 'string' && typeof value !== 'number') throw fail(400, `${field} must be text`);
  let s = String(value).replace(/\r\n?/g, '\n');
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  s = multiline ? s.trim().replace(/\n{4,}/g, '\n\n\n') : s.replace(/\s+/g, ' ').trim();
  if (required && !s) throw fail(400, `${field} is required`);
  if (s.length > max) throw fail(400, `${field} is too long (at most ${max} characters)`);
  return s;
}

// Only http(s) links are ever stored, so a wishlist can never carry a
// javascript: or data: URL into somebody else's page. "shop.example/item" is
// accepted and becomes https://shop.example/item.
function link(value, field = 'Link') {
  const s = text(value, { field, max: 2000 });
  if (!s) return '';
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(s);
  let u;
  try {
    u = new URL(hasScheme ? s : `https://${s}`);
  } catch {
    throw fail(400, `${field} is not a valid web address`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw fail(400, `${field} must start with http:// or https://`);
  if (!u.hostname.includes('.') && u.hostname !== 'localhost') throw fail(400, `${field} is not a valid web address`);
  return u.href;
}

function id(value, field = 'id') {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw fail(400, `${field} is invalid`);
  return n;
}

function optionalId(value, field) {
  if (value === undefined || value === null || value === '' || value === 0) return null;
  return id(value, field);
}

function bool(value) {
  return value === true || value === 1 || value === '1' || value === 'true' || value === 'on';
}

function date(value, field, { required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw fail(400, `${field} is required`);
    return null;
  }
  if (!isDate(value)) throw fail(400, `${field} must be a date (YYYY-MM-DD)`);
  return value;
}

function int(value, field, { min = -Infinity, max = Infinity, fallback } = {}) {
  if ((value === undefined || value === null || value === '') && fallback !== undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw fail(400, `${field} must be a whole number between ${min} and ${max}`);
  return n;
}

function oneOf(value, field, allowed, fallback) {
  if ((value === undefined || value === null || value === '') && fallback !== undefined) return fallback;
  if (!allowed.includes(value)) throw fail(400, `${field} must be one of ${allowed.join(', ')}`);
  return value;
}

// ---- crypto ------------------------------------------------------------------
const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// scrypt, parameters stored with the hash so they can be raised later.
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const N = 16384; const r = 8; const p = 1;
  const key = crypto.scryptSync(String(password), salt, 64, { N, r, p, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, keyB64] = parts;
  const expected = Buffer.from(keyB64, 'base64');
  const key = crypto.scryptSync(String(password), Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(N), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024,
  });
  return crypto.timingSafeEqual(key, expected);
}

const displayName = (u) => (u && (u.display_name || u.username)) || '';

module.exports = {
  HttpError, fail, nowIso, today, addDays, isDate, normEmail, isEmail,
  text, link, id, optionalId, bool, date, int, oneOf,
  randomToken, sha256, safeEqual, hashPassword, verifyPassword, displayName,
};
