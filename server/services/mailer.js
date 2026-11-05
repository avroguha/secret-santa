'use strict';
// Mail through an open SMTP relay (no username, no password), configured by an
// admin in the app. The outbox table is both the send queue and the log:
// notifications are queued and sent by a background loop, so drawing names
// for 300 people never makes a page wait on the relay.
//
// Demo mode never mails anybody: every message is kept in the outbox as
// "captured" and can be read there. The one exception is the admin's own
// "send a test email", which is sent for real so the relay can be tried out.
const nodemailer = require('nodemailer');
const { nowIso } = require('../lib/util');

const MAX_ATTEMPTS = 3;

class Mailer {
  constructor(app) {
    this.app = app;
    this.timer = null;
    this.busy = false;
    this.transport = null;
    this.transportKey = '';
  }

  relay() {
    return this.app.settings.read('email');
  }

  isConfigured() {
    const s = this.relay();
    return Boolean(s.host && s.fromEmail);
  }

  getTransport() {
    const s = this.relay();
    const key = JSON.stringify([s.host, s.port, s.security, s.allowInvalidCert]);
    if (this.transport && key === this.transportKey) return this.transport;
    if (this.transport) this.transport.close();
    this.transport = nodemailer.createTransport({
      host: s.host,
      port: Number(s.port) || 25,
      secure: s.security === 'tls',
      requireTLS: s.security === 'starttls',
      ignoreTLS: s.security === 'none',
      tls: { rejectUnauthorized: !s.allowInvalidCert },
      connectionTimeout: 15000,
      greetingTimeout: 10000,
      socketTimeout: 30000,
    });
    this.transportKey = key;
    return this.transport;
  }

  async sendNow({ to, toName, subject, html, text }) {
    const s = this.relay();
    if (!s.host || !s.fromEmail) throw new Error('The mail relay is not configured yet (Admin > Email)');
    const fromName = s.fromName || this.app.settings.read('general').appTitle;
    return this.getTransport().sendMail({
      from: { name: fromName, address: s.fromEmail },
      to: toName ? { name: toName, address: to } : to,
      replyTo: s.replyTo || undefined,
      subject,
      html,
      text,
      headers: { 'X-Auto-Response-Suppress': 'All', 'Auto-Submitted': 'auto-generated' },
    });
  }

  record({ to, toName = '', subject, html, text, kind }, status, error = '') {
    const at = nowIso();
    return this.app.db.run(
      `INSERT INTO outbox (to_email, to_name, subject, html, text, kind, status, attempts, error, created_at, sent_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      to, toName, subject, html, text, kind, status, status === 'sent' || status === 'failed' ? 1 : 0, error, at,
      status === 'sent' ? at : null,
    ).lastInsertRowid;
  }

  enqueue(msg) {
    const demo = this.app.config.demo.enabled;
    const id = this.record(msg, demo ? 'captured' : 'queued');
    if (!demo) this.kick();
    return id;
  }

  kick() {
    setImmediate(() => { this.processQueue().catch(() => {}); });
  }

  async processQueue() {
    if (this.app.config.demo.enabled || !this.isConfigured()) return;
    // Mail queued while a round is running is picked up straight after it,
    // not 15 seconds later.
    if (this.busy) {
      this.again = true;
      return;
    }
    this.busy = true;
    try {
      do {
        this.again = false;
        if (!(await this.sendRound())) break;
      } while (this.again || this.app.db.get("SELECT 1 FROM outbox WHERE status = 'queued' AND attempts = 0 LIMIT 1"));
    } finally {
      this.busy = false;
    }
  }

  // One batch. Returns false when the relay looks down, so the caller stops.
  async sendRound() {
    {
      const rows = this.app.db.all("SELECT * FROM outbox WHERE status = 'queued' ORDER BY id LIMIT 25");
      for (const row of rows) {
        try {
          await this.sendNow({ to: row.to_email, toName: row.to_name, subject: row.subject, html: row.html, text: row.text });
          this.app.db.run("UPDATE outbox SET status = 'sent', attempts = attempts + 1, error = '', sent_at = ? WHERE id = ?", nowIso(), row.id);
        } catch (err) {
          const attempts = row.attempts + 1;
          this.app.db.run(
            'UPDATE outbox SET status = ?, attempts = ?, error = ? WHERE id = ?',
            attempts >= MAX_ATTEMPTS ? 'failed' : 'queued', attempts, String(err.message || err).slice(0, 500), row.id,
          );
          // The relay is down: stop for this round rather than failing every message in it.
          if (/ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENOTFOUND|EAI_AGAIN|Greeting never received|Connection timeout/i.test(String(err.message))) return false;
        }
      }
    }
    return true;
  }

  start() {
    this.timer = setInterval(() => { this.processQueue().catch(() => {}); }, 15000);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.transport) this.transport.close();
  }
}

module.exports = { Mailer, MAX_ATTEMPTS };
