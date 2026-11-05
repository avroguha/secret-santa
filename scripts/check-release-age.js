#!/usr/bin/env node
// The 72-hour gate: no package younger than that is ever installed.
//
// A freshly published version is the window in which a hijacked maintainer
// account or a typo-squat does its damage; three days is long enough for the
// registry, the maintainers and the scanners to notice. So every package
// in the lockfile must have been published at least RELEASE_AGE_HOURS before
// the moment it is installed.
//
// `npm install --before` does NOT do this: with a lockfile present it installs
// the locked versions without consulting publish dates (tested: a cutoff of
// 2024 still installed a 2026 release). Hence this script. It reads
// package-lock.json, looks up each version's publish time on the registry,
// and fails if any is too young. Publish times never change, so they are
// cached in deps-publish-times.json next to the lockfile and committed; a
// build only reaches the registry for versions it has not seen before, and
// `--update` refreshes the cache after a dependency change.
//
//   node scripts/check-release-age.js [--dir .] [--hours 72] [--update] [--offline]
//
// --offline: never contact a registry - judge from the committed cache alone.
// The Docker build uses it, so a build behind a closed proxy needs no lookup.
//
// Exit 0: every package is old enough. Exit 1: at least one is not, or a
// publish time could not be determined - an unverifiable package is treated
// as too young, never waved through.
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_HOURS = 72;
// The registry to ask for publish times: the env file's NPM_REGISTRY in the
// office (Artifactory passes the `time` field through for remote npm repos),
// the public registry otherwise. A registry that does not return `time`
// leaves the package UNVERIFIED and the build refused - refresh the cache
// from a registry that does, and commit it.
const REGISTRY = (process.env.NPM_REGISTRY || process.env.npm_config_registry
  || 'https://registry.npmjs.org/').replace(/\/+$/, '');
const TOKEN = process.env.NPM_TOKEN || '';

function readLock(dir) {
  const lock = JSON.parse(fs.readFileSync(path.join(dir, 'package-lock.json'), 'utf8'));
  const out = new Map();
  for (const [key, entry] of Object.entries(lock.packages || {})) {
    if (!key || entry.link || !entry.version) continue;      // the root, or a workspace link
    const name = entry.name || key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
    out.set(`${name}@${entry.version}`, { name, version: entry.version });
  }
  return out;
}

async function fetchPublishTime(name, version, fetchImpl = fetch) {
  const headers = { accept: 'application/json' };
  if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;
  const r = await fetchImpl(`${REGISTRY}/${name.replace('/', '%2F')}`, { headers });
  if (!r.ok) throw new Error(`registry ${r.status} for ${name}`);
  const doc = await r.json();
  const t = doc.time && doc.time[version];
  if (!t) throw new Error(`no publish time for ${name}@${version}`);
  return t;
}

// The decision, separated from I/O so it can be tested without a registry.
function judge(entries, times, { hours = DEFAULT_HOURS, now = Date.now() } = {}) {
  const cutoff = now - hours * 3600e3;
  const tooYoung = [];
  const unknown = [];
  let youngest = null;
  for (const [key] of entries) {
    const t = times[key];
    if (!t) { unknown.push(key); continue; }
    const at = Date.parse(t);
    if (!Number.isFinite(at)) { unknown.push(key); continue; }
    if (at > cutoff) tooYoung.push({ key, hours: (now - at) / 3600e3 });
    if (!youngest || at > youngest.at) youngest = { key, at };
  }
  return { tooYoung, unknown, youngest, cutoff };
}

async function run(argv) {
  const arg = (flag, dflt) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : dflt; };
  const dir = path.resolve(arg('--dir', '.'));
  const hours = Number(arg('--hours', DEFAULT_HOURS)) || DEFAULT_HOURS;
  const update = argv.includes('--update');
  const offline = argv.includes('--offline');
  const cacheFile = path.join(dir, 'deps-publish-times.json');
  const entries = readLock(dir);
  let times = {};
  try { times = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch { times = {}; }

  const missing = [...entries.keys()].filter((k) => !times[k]);
  if (missing.length && offline) {
    console.error(`release-age: ${missing.length} package(s) are not in deps-publish-times.json and --offline forbids a lookup.`
      + ' Run "npm run deps:age" at home and commit the cache.');
  } else if (missing.length) {
    console.log(`release-age: looking up ${missing.length} publish time(s) not in the cache`);
    let i = 0;
    const workers = Array.from({ length: 8 }, async () => {
      for (;;) {
        const key = missing[i]; i += 1;
        if (!key) return;
        const { name, version } = entries.get(key);
        try { times[key] = await fetchPublishTime(name, version); }
        catch (err) { console.error(`release-age: ${err.message}`); }
      }
    });
    await Promise.all(workers);
    if (update) {
      // Drop versions no longer in the lock so the cache does not grow for ever.
      const kept = {};
      for (const k of [...entries.keys()].sort()) if (times[k]) kept[k] = times[k];
      fs.writeFileSync(cacheFile, `${JSON.stringify(kept, null, 2)}\n`);
      console.log(`release-age: cache written, ${Object.keys(kept).length} entries`);
    }
  }

  const v = judge(entries, times, { hours });
  if (v.youngest) {
    const age = ((Date.now() - v.youngest.at) / 3600e3).toFixed(1);
    console.log(`release-age: ${entries.size} package(s); youngest ${v.youngest.key} `
      + `published ${age}h ago; gate ${hours}h`);
  }
  for (const u of v.unknown) console.error(`release-age: UNVERIFIED ${u} - no publish time available`);
  for (const t of v.tooYoung) {
    console.error(`release-age: TOO YOUNG ${t.key} - published ${t.hours.toFixed(1)}h ago, gate is ${hours}h`);
  }
  if (v.unknown.length || v.tooYoung.length) {
    console.error(`release-age: REFUSED - ${v.tooYoung.length} too young, ${v.unknown.length} unverified. `
      + 'Wait for the gate, or pin an older version, then `npm run deps:age` to refresh the cache.');
    return 1;
  }
  console.log('release-age: OK');
  return 0;
}

if (require.main === module) {
  run(process.argv.slice(2)).then((code) => process.exit(code), (err) => {
    console.error(`release-age: ${err.message}`); process.exit(1);
  });
}

module.exports = { readLock, judge, fetchPublishTime, run, DEFAULT_HOURS };
