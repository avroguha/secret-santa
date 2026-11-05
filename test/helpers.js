'use strict';
// Test helpers: an app on a random port with its own temporary data folder, a
// cookie-keeping client, and a tiny SMTP server that catches what is sent.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { loadConfig } = require('../server/config');
const { createApp } = require('../server/app');

async function startApp(env = {}, dir = fs.mkdtempSync(path.join(os.tmpdir(), 'santa-test-'))) {
  const config = loadConfig({ SANTA_DATA_DIR: dir, ...env }, []);
  const app = createApp(config);
  const server = http.createServer(app.handle);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    app, base, dir, config,
    client: () => new Client(base),
    close: () => new Promise((r) => { server.close(() => { app.stop(); r(); }); }),
  };
}

class Client {
  constructor(base) {
    this.base = base;
    this.jar = {};
  }

  async req(method, p, body, { csrf = true } = {}) {
    const headers = { cookie: Object.entries(this.jar).map(([k, v]) => `${k}=${v}`).join('; ') };
    if (csrf && this.jar.ss_csrf) headers['x-csrf-token'] = this.jar.ss_csrf;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const r = await fetch(this.base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
    for (const c of r.headers.getSetCookie()) {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      const k = kv.slice(0, i);
      const v = kv.slice(i + 1);
      if (/Max-Age=0/.test(c)) delete this.jar[k];
      else this.jar[k] = v;
    }
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = null; }
    return { status: r.status, body: json, text, headers: r.headers };
  }

  get(p) { return this.req('GET', p); }
  post(p, b = {}) { return this.req('POST', p, b); }
  put(p, b = {}) { return this.req('PUT', p, b); }
  del(p) { return this.req('DELETE', p); }

  async init() {
    await this.get('/api/session');
    return this;
  }
}

// Just enough SMTP for nodemailer without TLS: greets, accepts, stores the DATA.
function fakeSmtp() {
  const messages = [];
  const server = net.createServer((sock) => {
    let buf = '';
    let inData = false;
    let current = { rcpt: [] };
    sock.write('220 fake.test ESMTP\r\n');
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      for (;;) {
        if (inData) {
          const end = buf.indexOf('\r\n.\r\n');
          if (end < 0) return;
          current.data = buf.slice(0, end);
          buf = buf.slice(end + 5);
          messages.push(current);
          current = { rcpt: [] };
          inData = false;
          sock.write('250 OK queued\r\n');
          continue;
        }
        const nl = buf.indexOf('\r\n');
        if (nl < 0) return;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === 'EHLO' || cmd === 'HELO') sock.write('250-fake.test\r\n250 8BITMIME\r\n');
        else if (cmd === 'MAIL') { current.from = line; sock.write('250 OK\r\n'); }
        else if (cmd === 'RCPT') { current.rcpt.push(line); sock.write('250 OK\r\n'); }
        else if (cmd === 'DATA') { inData = true; sock.write('354 go ahead\r\n'); }
        else if (cmd === 'QUIT') { sock.end('221 bye\r\n'); return; }
        else sock.write('250 OK\r\n');
      }
    });
    sock.on('error', () => {});
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, messages, close: () => new Promise((r) => server.close(r)) }));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeout = 5000, step = 50 } = {}) {
  const until = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error('timed out waiting');
    await sleep(step);
  }
}

module.exports = { startApp, Client, fakeSmtp, sleep, waitFor };
