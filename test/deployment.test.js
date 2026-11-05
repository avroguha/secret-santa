'use strict';
// Guards for the deployment rules. They read the deployment files as text and
// fail when a rule is broken - these regressions never show up in app tests.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const LOCATIONS = ['IMAGE_REGISTRY', 'APT_MIRROR', 'NPM_REGISTRY', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY'];
const HOUR = 3600e3;

const envKeys = (text) => Object.fromEntries([...text.matchAll(/^([A-Z_][A-Z0-9_]*)=(.*)$/gm)].map((m) => [m[1], m[2]]));

test('the Dockerfile bakes in no site location and persists no proxy, registry or token', () => {
  const d = read('Dockerfile');
  assert.match(d, /^ARG IMAGE_REGISTRY=$/m);
  for (const k of ['APT_MIRROR', 'NPM_REGISTRY', 'NPM_TOKEN', 'HTTP_PROXY', 'HTTPS_PROXY']) {
    for (const m of d.matchAll(new RegExp(`^ARG ${k}=(.*)$`, 'gm'))) assert.equal(m[1], '', `${k} must have no built-in value`);
  }
  for (const m of d.matchAll(/^ARG NO_PROXY=(.*)$/gm)) assert.equal(m[1], 'localhost,127.0.0.1');
  assert.ok(d.includes(': "${NPM_REGISTRY:?'), 'a build without an env file must stop, not fall back');
  // every line of every ENV instruction, continuation lines included
  const envLines = [];
  let inEnv = false;
  for (const l of d.split('\n')) {
    if (l.startsWith('ENV')) inEnv = true;
    if (inEnv) envLines.push(l);
    if (!l.trimEnd().endsWith('\\')) inEnv = false;
  }
  assert.ok(envLines.length > 0);
  for (const line of envLines) {
    assert.ok(!/(proxy|NPM_REGISTRY|NPM_TOKEN|APT_MIRROR)/i.test(line) || /NODE_USE_ENV_PROXY/.test(line), `persisted: ${line}`);
  }
});

test('every image is pulled through IMAGE_REGISTRY, pinned by digest, and the pin is at least 72 hours old', () => {
  const d = read('Dockerfile');
  const pins = JSON.parse(read('image-pins.json'));
  const froms = [...d.matchAll(/^FROM (\S+)/gm)].map((m) => m[1]);
  assert.ok(froms.length >= 2);
  for (const f of froms) assert.ok(f.startsWith('${IMAGE_REGISTRY}'), f);
  const images = [...d.matchAll(/^ARG IMAGE_(?!REGISTRY)\w+=(\S+)$/gm)].map((m) => m[1]);
  assert.ok(images.length >= 2);
  for (const img of images) {
    const [ref, digest] = img.split('@');
    assert.match(digest || '', /^sha256:[0-9a-f]{64}$/, `${img} is not pinned by digest`);
    const pin = pins[ref];
    assert.ok(pin, `${ref} is missing from image-pins.json`);
    assert.equal(pin.digest, digest, `${ref}: digest differs from image-pins.json`);
    assert.ok(Date.parse(pin.pinnedAt) - Date.parse(pin.pushedAt) >= 72 * HOUR, `${ref} was pinned less than 72 hours after it was pushed`);
  }
});

test('the 72-hour gate runs after npm ci, offline, and the cache covers the lockfile', () => {
  const d = read('Dockerfile');
  assert.ok(d.indexOf('npm ci') > 0 && d.indexOf('npm ci') < d.indexOf('check-release-age.js --hours 72 --offline'));
  assert.ok(!/npm install/.test(d), 'install from the lockfile only');
  const lock = JSON.parse(read('package-lock.json'));
  const cache = JSON.parse(read('deps-publish-times.json'));
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (!key) continue;
    const name = key.slice(key.lastIndexOf('node_modules/') + 13);
    const at = cache[`${name}@${entry.version}`];
    assert.ok(at, `${name}@${entry.version} has no cached publish time - run npm run deps:age`);
    assert.ok(Date.now() - Date.parse(at) >= 72 * HOUR, `${name}@${entry.version} is younger than 72 hours`);
  }
  assert.equal(JSON.parse(read('package.json')).dependencies.nodemailer, lock.packages['node_modules/nodemailer'].version, 'exact version pin');
});

test('legacy builder compatible, unprivileged, cheap health check', () => {
  const d = read('Dockerfile');
  assert.ok(!/RUN --mount|^# syntax=|COPY --chmod|COPY --link|<<\s*['"]?EOF/m.test(d), 'BuildKit-only syntax');
  assert.match(d, /userdel -r ubuntu/);
  assert.match(d, /useradd -r -u 10001/);
  const hc = d.slice(d.indexOf('HEALTHCHECK'), d.indexOf('ENTRYPOINT'));
  assert.match(hc, /curl/);
  assert.ok(!/node -e|python/.test(hc), 'no language runtime in the health check');
  assert.match(d, /apt-get install[^\n]*\bcurl\b/);
});

test('compose requires every location from the env file and never pulls the local image', () => {
  const c = read('docker-compose.yml');
  for (const k of LOCATIONS) {
    assert.match(c, new RegExp(`\\b${k}: \\$\\{${k}\\?`), `${k} must be required`);
    assert.ok(!new RegExp(`\\$\\{${k}:?-`).test(c), `${k} must not have a built-in default`);
  }
  assert.match(c, /NPM_TOKEN: \$\{NPM_TOKEN-\}/, 'the token reaches the build, empty by default');
  assert.match(c, /pull_policy: build/);
  assert.match(c, /network_mode: host/);
  assert.match(c, /HTTPS_PROXY: \$\{RUNTIME_HTTPS_PROXY\?/);
  assert.ok(!/^volumes:\s*$/m.test(c), 'bind mounts only, no named volumes');
  for (const pub of ['docker.io', 'ghcr.io', 'quay.io', 'registry.npmjs.org', 'pypi.org', 'archive.ubuntu.com']) {
    assert.ok(!c.includes(pub), `compose names a public location: ${pub}`);
  }
  assert.match(c, /SANTA_DEMO_MODE: \$\{SANTA_DEMO_MODE\?/);
  assert.match(c, /max-size/);
});

test('work.env and home.env define the same keys, everything compose requires, and no secrets', () => {
  const c = read('docker-compose.yml');
  const code = c.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
  const required = [...new Set([...code.matchAll(/\$\{([A-Z_][A-Z0-9_]*)\?/g)].map((m) => m[1]))];
  const work = envKeys(read('work.env'));
  const home = envKeys(read('home.env'));
  assert.deepEqual(Object.keys(work).sort(), Object.keys(home).sort());
  for (const k of required) {
    assert.ok(k in work, `work.env lacks ${k}`);
    assert.ok(k in home, `home.env lacks ${k}`);
  }
  for (const [name, env] of [['work.env', work], ['home.env', home]]) {
    for (const [k, v] of Object.entries(env)) {
      if (/(PASSWORD|SECRET|TOKEN|KEY)$/.test(k)) assert.equal(v, '', `${name} holds a value for ${k}`);
    }
    assert.match(env.SANTA_DEMO_MODE, /^(true|false)$/);
  }
  assert.equal(home.IMAGE_REGISTRY, '');
  assert.equal(home.HTTP_PROXY, '');
  assert.equal(home.HTTPS_PROXY, '');
  assert.match(work.IMAGE_REGISTRY, /\S+\/$/);
  // work.env carries placeholders only - generic names on avro.com
  for (const k of ['IMAGE_REGISTRY', 'APT_MIRROR', 'NPM_REGISTRY', 'HTTP_PROXY', 'HTTPS_PROXY', 'RUNTIME_HTTPS_PROXY']) {
    assert.match(work[k], /avro\.com/, `work.env ${k} should be an avro.com placeholder`);
  }
  assert.match(work.SANTA_DATA_DIR, /^\.\.\//, 'work data lives outside the code folder');
});

test('.gitignore keeps state, keys and certificates out but not the env files', () => {
  const g = read('.gitignore').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  for (const p of ['/data/', '/secrets/', '/tls/', '*.key', '/node_modules/']) assert.ok(g.includes(p), p);
  for (const p of g) {
    assert.ok(!/(^|\/)(work|home)\.env$|^\*\.env$/.test(p), `env files must be committed: ${p}`);
    if (p.endsWith('/') && !p.startsWith('*')) assert.ok(p.startsWith('/'), `directory rule not anchored: ${p}`);
  }
  const di = read('.dockerignore');
  for (const p of ['data', 'secrets', 'tls', 'node_modules']) assert.match(di, new RegExp(`^${p}$`, 'm'));
});

test('shell scripts are LF and the npm test glob is quoted', () => {
  const raw = fs.readFileSync(path.join(ROOT, 'docker-entrypoint.sh'));
  assert.ok(!raw.includes(Buffer.from('\r\n')), 'CRLF in the entrypoint gives "bad interpreter" on Linux');
  assert.match(read('.gitattributes'), /\*\.sh text eol=lf/);
  assert.match(read('Dockerfile'), /sed -i 's\/\\r\$\/\/' \/usr\/local\/bin\/docker-entrypoint\.sh/);
  assert.match(JSON.parse(read('package.json')).scripts.test, /"test\/\*\.test\.js"/);
});

// The private deny list (one ERE per line) lives outside every repository; when it
// is present on this machine, no project file may match any of its terms.
test('no company term anywhere in the project', (t) => {
  const listFile = path.join(os.homedir(), '.config', 'git', 'denylist');
  if (!fs.existsSync(listFile)) {
    t.skip('no deny list on this machine');
    return;
  }
  const patterns = fs.readFileSync(listFile, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    .map((p) => new RegExp(p, 'i'));
  const skip = new Set(['node_modules', 'data', 'tls', 'secrets', '.git']);
  const hits = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (!/\.(sqlite|png|ico)$/.test(e.name)) {
        const text = `${path.relative(ROOT, p)}\n${fs.readFileSync(p, 'utf8')}`;
        if (patterns.some((re) => re.test(text))) hits.push(path.relative(ROOT, p));
      }
    }
  };
  walk(ROOT);
  assert.deepEqual(hits, [], 'files containing a deny-listed term (terms not printed on purpose)');
});
