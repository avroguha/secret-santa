'use strict';
// Microsoft Entra ID (Azure AD) sign-in: OpenID Connect authorization-code
// flow with PKCE, done with fetch and node:crypto - no OIDC library.
//
// Register a "Web" application in Entra ID with the redirect URI
//   <SANTA_BASE_URL>/auth/azure/callback
// and give the app its tenant id, client id (env file) and client secret (a
// file, SANTA_AZURE_CLIENT_SECRET_FILE). The ID token is validated in full:
// RS256 signature against the tenant's published keys, issuer, audience,
// expiry and nonce.
const crypto = require('node:crypto');
const { readSecretFile } = require('../config');
const { randomToken, fail } = require('../lib/util');

const PENDING_TTL = 10 * 60e3;
const CACHE_TTL = 3600e3;

function b64urlJson(part) {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

function create(app) {
  const { config } = app;
  const pending = new Map();
  let discovery = null;
  let jwks = null;

  const settings = () => config.azure;
  const secret = () => readSecretFile(config.azure.secretFile);

  function status() {
    const a = settings();
    const missing = [];
    if (!a.tenantId) missing.push('SANTA_AZURE_TENANT_ID');
    // "common" / "organizations" / "consumers" would let any Microsoft tenant's
    // accounts in, and an email claim from a stranger's tenant proves nothing.
    else if (/^(common|organizations|consumers)$/i.test(a.tenantId)) missing.push('SANTA_AZURE_TENANT_ID (your own tenant id - not common, organizations or consumers)');
    if (!a.clientId) missing.push('SANTA_AZURE_CLIENT_ID');
    if (!secret()) missing.push(`client secret file (${a.secretFile})`);
    return {
      configured: missing.length === 0,
      missing,
      tenantId: a.tenantId,
      clientId: a.clientId,
      secretFile: a.secretFile,
      redirectUri: redirectUri(),
    };
  }

  const available = () => status().configured && Boolean(app.settings.read('auth').azureEnabled);

  function redirectUri(origin) {
    return `${app.publicUrl(origin)}/auth/azure/callback`;
  }

  async function getJson(url, init) {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(15000) });
    const text = await r.text();
    let body;
    try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 300) }; }
    if (!r.ok) {
      const why = body.error_description || body.error || body.raw || r.statusText;
      throw new Error(`${new URL(url).host} answered ${r.status}: ${String(why).split('\r\n')[0]}`);
    }
    return body;
  }

  async function getDiscovery(force = false) {
    const a = settings();
    if (!force && discovery && discovery.at > Date.now() - CACHE_TTL && discovery.tenant === a.tenantId) return discovery.doc;
    const doc = await getJson(`${a.authority}/${encodeURIComponent(a.tenantId)}/v2.0/.well-known/openid-configuration`);
    discovery = { doc, at: Date.now(), tenant: a.tenantId };
    return doc;
  }

  async function getKey(kid) {
    const doc = await getDiscovery();
    const find = () => jwks && jwks.keys.find((k) => k.kid === kid);
    if (!find() || jwks.at < Date.now() - CACHE_TTL) {
      const set = await getJson(doc.jwks_uri);
      jwks = { keys: set.keys || [], at: Date.now() };
    }
    const jwk = find();
    if (!jwk) throw new Error('the token was signed with a key Microsoft does not publish for this tenant');
    return crypto.createPublicKey({ key: jwk, format: 'jwk' });
  }

  async function validateIdToken(idToken, nonce) {
    const parts = String(idToken || '').split('.');
    if (parts.length !== 3) throw new Error('no ID token in the response');
    const header = b64urlJson(parts[0]);
    const claims = b64urlJson(parts[1]);
    if (header.alg !== 'RS256') throw new Error(`unexpected token algorithm ${header.alg}`);
    const key = await getKey(header.kid);
    const ok = crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'));
    if (!ok) throw new Error('the ID token signature is invalid');
    const doc = await getDiscovery();
    const a = settings();
    const expectedIss = String(doc.issuer).replace('{tenantid}', claims.tid || '');
    if (claims.iss !== expectedIss) throw new Error(`token issuer ${claims.iss} is not ${expectedIss}`);
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(a.clientId)) throw new Error('the token was issued to a different application');
    const now = Math.floor(Date.now() / 1000);
    if (typeof claims.exp !== 'number' || claims.exp < now - 300) throw new Error('the token has expired');
    if (typeof claims.nbf === 'number' && claims.nbf > now + 300) throw new Error('the token is not valid yet');
    if (!claims.nonce || claims.nonce !== nonce) throw new Error('the sign-in response does not belong to this browser session');
    return claims;
  }

  async function begin(ctx) {
    if (!available()) throw fail(404, 'Microsoft sign-in is not set up');
    const doc = await getDiscovery();
    for (const [k, v] of pending) if (v.at < Date.now() - PENDING_TTL) pending.delete(k);
    const state = randomToken(24);
    const nonce = randomToken(24);
    const verifier = randomToken(48);
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const origin = ctx.origin;
    pending.set(state, { nonce, verifier, at: Date.now(), origin });
    const params = new URLSearchParams({
      client_id: settings().clientId,
      response_type: 'code',
      redirect_uri: redirectUri(origin),
      response_mode: 'query',
      scope: 'openid profile email',
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      prompt: 'select_account',
    });
    return { url: `${doc.authorization_endpoint}?${params}`, state };
  }

  async function finish(ctx, { code, state, cookieState }) {
    const p = state && pending.get(state);
    if (!p || p.at < Date.now() - PENDING_TTL) throw new Error('the sign-in took too long or was started in another browser - try again');
    pending.delete(state);
    if (!cookieState || cookieState !== state) throw new Error('the sign-in was started in another browser - try again');
    const doc = await getDiscovery();
    const body = new URLSearchParams({
      client_id: settings().clientId,
      client_secret: secret(),
      grant_type: 'authorization_code',
      code: String(code || ''),
      redirect_uri: redirectUri(p.origin),
      code_verifier: p.verifier,
      scope: 'openid profile email',
    });
    const tokens = await getJson(doc.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body,
    });
    const claims = await validateIdToken(tokens.id_token, p.nonce);
    return {
      email: String(claims.email || claims.preferred_username || claims.upn || '').toLowerCase(),
      username: String(claims.preferred_username || claims.upn || '').toLowerCase(),
      name: String(claims.name || ''),
      oid: claims.oid,
    };
  }

  async function test() {
    const s = status();
    if (!s.tenantId || !s.clientId) return { ok: false, message: `Not configured: ${s.missing.join(', ')}` };
    try {
      const doc = await getDiscovery(true);
      return {
        ok: s.configured,
        message: s.configured
          ? `Reached Microsoft: ${doc.issuer}`
          : `Reached Microsoft, but still missing: ${s.missing.join(', ')}`,
      };
    } catch (err) {
      return { ok: false, message: `Could not reach Microsoft: ${err.message}. Behind a proxy, set RUNTIME_HTTPS_PROXY in the env file.` };
    }
  }

  return { status, available, begin, finish, test, validateIdToken, redirectUri };
}

module.exports = { create };
