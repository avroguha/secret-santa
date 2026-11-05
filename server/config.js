'use strict';
// Runtime configuration, read once from the environment.
//
// Everything a deployment decides lives here; everything an ADMIN decides
// (mail relay, sign-in switches, notifications) lives in the database and is
// edited in the app. Secrets are never environment values: the Azure client
// secret is read from a file (SANTA_AZURE_CLIENT_SECRET_FILE).
const fs = require('node:fs');
const path = require('node:path');

function flag(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
}

function loadConfig(env = process.env, argv = process.argv) {
  const demoEnabled = argv.includes('--demo') || flag(env.SANTA_DEMO_MODE, false);
  const dataDir = path.resolve(env.SANTA_DATA_DIR || path.join(__dirname, '..', 'data'));
  const baseUrl = String(env.SANTA_BASE_URL || '').trim().replace(/\/+$/, '');
  const demoOtp = String(env.SANTA_DEMO_OTP || '123456').trim();
  if (!/^\d{4,8}$/.test(demoOtp)) {
    throw new Error('SANTA_DEMO_OTP must be 4 to 8 digits');
  }
  const port = Number(env.SANTA_PORT || 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SANTA_PORT must be a port number');

  return {
    port,
    bind: String(env.SANTA_BIND || '0.0.0.0').trim(),
    dataDir,
    // Demo data lives in its OWN database file. Turning demo mode off switches
    // to the real database, so no demo record can ever show up there, and
    // turning it back on never touches real data.
    dbFile: path.join(dataDir, demoEnabled ? 'demo.sqlite' : 'santa.sqlite'),
    demo: {
      enabled: demoEnabled,
      otp: demoOtp,
      resetOnStart: flag(env.SANTA_DEMO_RESET_ON_START, false),
    },
    baseUrl,
    cookieSecure: flag(env.SANTA_COOKIE_SECURE, baseUrl.startsWith('https://')),
    trustProxy: flag(env.SANTA_TRUST_PROXY, false),
    tlsDir: String(env.SANTA_TLS_DIR || '').trim(),
    tlsCertName: String(env.SANTA_TLS_CERT_NAME || 'tls.crt').trim(),
    tlsKeyName: String(env.SANTA_TLS_KEY_NAME || 'tls.key').trim(),
    azure: {
      tenantId: String(env.SANTA_AZURE_TENANT_ID || '').trim(),
      clientId: String(env.SANTA_AZURE_CLIENT_ID || '').trim(),
      secretFile: String(env.SANTA_AZURE_CLIENT_SECRET_FILE || '/secrets/azure_client_secret').trim(),
      authority: String(env.SANTA_AZURE_AUTHORITY || 'https://login.microsoftonline.com').trim().replace(/\/+$/, ''),
    },
    publicDir: path.join(__dirname, '..', 'public'),
    version: require('../package.json').version,
  };
}

// Read lazily, at the moment it is needed, so a rotated secret file takes
// effect without a restart - and so the value never sits in the config object.
function readSecretFile(file) {
  if (!file) return '';
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return '';
  }
}

module.exports = { loadConfig, readSecretFile, flag };
