'use strict';
// Start the server: HTTPS when a certificate and key are in SANTA_TLS_DIR,
// plain HTTP otherwise (behind a TLS-terminating proxy, or on a laptop).
//
//   node server/index.js                 real data (data/santa.sqlite)
//   node server/index.js --demo          demo data (data/demo.sqlite), every code 123456
//   node server/index.js --reset-admin   put admin / admin back, then exit
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { loadConfig } = require('./config');
const { createApp, resetAdmin } = require('./app');

function main() {
  const config = loadConfig();

  if (process.argv.includes('--reset-admin')) {
    const { openDb } = require('./db');
    const db = openDb(config.dbFile);
    resetAdmin(db);
    db.close();
    console.log(`admin / admin restored in ${config.dbFile}; change it at the next sign-in.`);
    return;
  }

  const app = createApp(config);
  let server;
  let scheme = 'http';
  const cert = config.tlsDir && path.join(config.tlsDir, config.tlsCertName);
  const key = config.tlsDir && path.join(config.tlsDir, config.tlsKeyName);
  if (cert && key && fs.existsSync(cert) && fs.existsSync(key)) {
    const load = () => ({ cert: fs.readFileSync(cert), key: fs.readFileSync(key) });
    server = https.createServer(load(), app.handle);
    scheme = 'https';
    // A replaced certificate is picked up without a restart.
    let stamp = `${fs.statSync(cert).mtimeMs}:${fs.statSync(key).mtimeMs}`;
    setInterval(() => {
      try {
        const now = `${fs.statSync(cert).mtimeMs}:${fs.statSync(key).mtimeMs}`;
        if (now !== stamp) {
          server.setSecureContext(load());
          stamp = now;
          console.log('TLS certificate reloaded');
        }
      } catch (err) {
        console.error(`TLS reload: ${err.message}`);
      }
    }, 5 * 60e3).unref();
  } else {
    server = http.createServer(app.handle);
  }
  server.headersTimeout = 20000;
  server.requestTimeout = 60000;
  server.listen(config.port, config.bind, () => {
    console.log(`🎅 Secret Santa ${config.version} on ${scheme}://${config.bind}:${config.port}`
      + `${config.demo.enabled ? `  [DEMO MODE - every sign-in code is ${config.demo.otp}]` : ''}`);
    console.log(`   database ${config.dbFile}`);
    if (!config.baseUrl) console.log('   SANTA_BASE_URL is not set - set it so email links and Microsoft sign-in use the right address');
  });
  app.start();

  const shutdown = (sig) => {
    console.log(`${sig}: shutting down`);
    server.close(() => {
      app.stop();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main();
