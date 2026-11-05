'use strict';
// A deliberately small HTTP layer: a router, cookies, JSON bodies, static
// files and security headers. No framework, so nothing to vet but nodemailer.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { HttpError } = require('./util');

class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, handler, opts = {}) {
    const keys = [];
    const source = pattern
      .split('/')
      .map((part) => {
        if (part.startsWith(':')) {
          keys.push(part.slice(1));
          return '([^/]+)';
        }
        return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      })
      .join('/');
    this.routes.push({ method, pattern, re: new RegExp(`^${source}/?$`), keys, handler, opts });
  }

  get(p, h, o) { this.add('GET', p, h, o); }
  post(p, h, o) { this.add('POST', p, h, o); }
  put(p, h, o) { this.add('PUT', p, h, o); }
  delete(p, h, o) { this.add('DELETE', p, h, o); }

  match(method, pathname) {
    let otherMethod = false;
    const m = method === 'HEAD' ? 'GET' : method;
    for (const r of this.routes) {
      const hit = r.re.exec(pathname);
      if (!hit) continue;
      if (r.method !== m) {
        otherMethod = true;
        continue;
      }
      const params = {};
      r.keys.forEach((k, i) => {
        try { params[k] = decodeURIComponent(hit[i + 1]); } catch { params[k] = hit[i + 1]; }
      });
      return { route: r, params };
    }
    return otherMethod ? { methodNotAllowed: true } : null;
  }
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k || k in out) continue;
    const v = part.slice(i + 1).trim();
    try { out[k] = decodeURIComponent(v); } catch { out[k] = v; }
  }
  return out;
}

function serializeCookie(name, value, opts = {}) {
  let s = `${name}=${encodeURIComponent(value)}; Path=${opts.path || '/'}`;
  if (opts.maxAge !== undefined) s += `; Max-Age=${Math.max(0, Math.floor(opts.maxAge))}`;
  if (opts.httpOnly) s += '; HttpOnly';
  if (opts.secure) s += '; Secure';
  s += `; SameSite=${opts.sameSite || 'Lax'}`;
  return s;
}

function appendCookie(res, cookie) {
  const prev = res.getHeader('set-cookie');
  const list = prev ? (Array.isArray(prev) ? prev : [prev]) : [];
  list.push(cookie);
  res.setHeader('set-cookie', list);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > limit) {
      reject(new HttpError(413, 'That upload is too large'));
      req.resume();
      return;
    }
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'That upload is too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req, limit) {
  const buf = await readBody(req, limit);
  if (!buf.length) return {};
  const type = String(req.headers['content-type'] || '');
  if (!type.includes('application/json')) throw new HttpError(415, 'Send JSON');
  try {
    const parsed = JSON.parse(buf.toString('utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    throw new HttpError(400, 'The request body is not valid JSON');
  }
}

// application/x-www-form-urlencoded - what an identity provider POSTs to us.
async function readForm(req, limit) {
  const buf = await readBody(req, limit);
  const type = String(req.headers['content-type'] || '');
  if (buf.length && !type.includes('application/x-www-form-urlencoded')) throw new HttpError(415, 'Send a form');
  return Object.fromEntries(new URLSearchParams(buf.toString('utf8')));
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendText(res, status, body, type = 'text/plain; charset=utf-8', extra = {}) {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body), ...extra });
  res.end(body);
}

function redirect(res, location) {
  res.writeHead(302, { location, 'cache-control': 'no-store' });
  res.end();
}

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

function securityHeaders(res, { tls } = {}) {
  res.setHeader('content-security-policy', CSP);
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'same-origin');
  res.setHeader('cross-origin-opener-policy', 'same-origin');
  res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  if (tls) res.setHeader('strict-transport-security', 'max-age=31536000');
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.woff2': 'font/woff2',
  '.md': 'text/markdown; charset=utf-8',
};

// Static files revalidate on every load (no-cache + ETag): a new release is
// picked up at once and an unchanged file costs a 304.
function serveStatic(req, res, root, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  try { rel = decodeURIComponent(rel); } catch { throw new HttpError(400, 'Bad path'); }
  if (rel.includes('\0')) throw new HttpError(400, 'Bad path');
  const file = path.normalize(path.join(root, rel));
  if (!file.startsWith(path.normalize(root + path.sep))) throw new HttpError(404, 'Not found');
  let stat;
  try { stat = fs.statSync(file); } catch { stat = null; }
  if (!stat || !stat.isFile()) throw new HttpError(404, 'Not found');
  const etag = `"${crypto.createHash('sha1').update(`${stat.size}-${stat.mtimeMs}`).digest('base64url')}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { etag, 'cache-control': 'no-cache' });
    res.end();
    return;
  }
  res.writeHead(200, {
    'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'content-length': stat.size,
    'cache-control': 'no-cache',
    etag,
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  fs.createReadStream(file).pipe(res);
}

module.exports = {
  Router, parseCookies, serializeCookie, appendCookie, readBody, readJson, readForm,
  sendJson, sendText, redirect, securityHeaders, serveStatic,
};
