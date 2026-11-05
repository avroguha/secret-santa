'use strict';
// SAML sign-in end to end, with a pretend identity provider made up on the spot:
// a fresh RSA key and a self-signed certificate (built in code, so no private
// key is ever stored in the repository), its metadata uploaded through the
// admin API, and responses signed the way Entra ID signs them.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { SignedXml } = require('xml-crypto');
const { startApp } = require('./helpers');

// ---- a minimal X.509 certificate, DER by hand ------------------------------------
const len = (n) => {
  if (n < 128) return Buffer.from([n]);
  const b = [];
  for (let v = n; v > 0; v >>= 8) b.unshift(v & 0xff);
  return Buffer.from([0x80 | b.length, ...b]);
};
const tlv = (tag, c) => Buffer.concat([Buffer.from([tag]), len(c.length), c]);
const seq = (...c) => tlv(0x30, Buffer.concat(c));
const set = (...c) => tlv(0x31, Buffer.concat(c));
const int = (b) => tlv(0x02, b[0] & 0x80 ? Buffer.concat([Buffer.from([0]), b]) : b);
const oid = (s) => {
  const p = s.split('.').map(Number);
  const out = [40 * p[0] + p[1]];
  for (const n of p.slice(2)) {
    const b = [n & 0x7f];
    for (let v = n >> 7; v > 0; v >>= 7) b.unshift((v & 0x7f) | 0x80);
    out.push(...b);
  }
  return tlv(0x06, Buffer.from(out));
};
const utc = (d) => tlv(0x17, Buffer.from(`${d.toISOString().replace(/[-:T]/g, '').slice(2, 14)}Z`));

function testIdentityProvider() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const alg = seq(oid('1.2.840.113549.1.1.11'), Buffer.from([0x05, 0x00]));
  const name = seq(set(seq(oid('2.5.4.3'), tlv(0x0c, Buffer.from('Test IdP')))));
  const now = Date.now();
  const tbs = seq(tlv(0xa0, int(Buffer.from([2]))), int(crypto.randomBytes(8)), alg, name,
    seq(utc(new Date(now - 86400e3)), utc(new Date(now + 365 * 86400e3))), name, publicKey.export({ type: 'spki', format: 'der' }));
  const der = seq(tbs, alg, tlv(0x03, Buffer.concat([Buffer.from([0]), crypto.sign('sha256', tbs, privateKey)])));
  const b64 = der.toString('base64');
  return {
    b64,
    certPem: `-----BEGIN CERTIFICATE-----\n${b64.match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`,
    keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    entityId: 'https://sts.idp.example/tenant-1234/',
    ssoUrl: 'https://login.idp.example/tenant-1234/saml2',
  };
}

const metadata = (idp) => `<?xml version="1.0" encoding="utf-8"?>
<EntityDescriptor ID="_m1" entityID="${idp.entityId}" xmlns="urn:oasis:names:tc:SAML:2.0:metadata">
  <IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <KeyDescriptor use="signing"><KeyInfo xmlns="http://www.w3.org/2000/09/xmldsig#"><X509Data><X509Certificate>${idp.b64}</X509Certificate></X509Data></KeyInfo></KeyDescriptor>
    <SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${idp.ssoUrl}"/>
    <SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${idp.ssoUrl}"/>
  </IDPSSODescriptor>
</EntityDescriptor>`;

function samlResponse(idp, { requestId, acs, audience, email, name = 'Holly Berry', tamper = false }) {
  const now = new Date();
  const iso = (ms) => new Date(now.getTime() + ms).toISOString();
  const xml = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_r${crypto.randomUUID()}" Version="2.0" IssueInstant="${iso(0)}" Destination="${acs}" InResponseTo="${requestId}">
<saml:Issuer>${idp.entityId}</saml:Issuer>
<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>
<saml:Assertion ID="_a${crypto.randomUUID()}" Version="2.0" IssueInstant="${iso(0)}">
<saml:Issuer>${idp.entityId}</saml:Issuer>
<saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${email}</saml:NameID>
<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData InResponseTo="${requestId}" NotOnOrAfter="${iso(300e3)}" Recipient="${acs}"/></saml:SubjectConfirmation></saml:Subject>
<saml:Conditions NotBefore="${iso(-60e3)}" NotOnOrAfter="${iso(300e3)}"><saml:AudienceRestriction><saml:Audience>${audience}</saml:Audience></saml:AudienceRestriction></saml:Conditions>
<saml:AttributeStatement>
<saml:Attribute Name="http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress"><saml:AttributeValue>${email}</saml:AttributeValue></saml:Attribute>
<saml:Attribute Name="http://schemas.microsoft.com/identity/claims/displayname"><saml:AttributeValue>${name}</saml:AttributeValue></saml:Attribute>
</saml:AttributeStatement>
<saml:AuthnStatement AuthnInstant="${iso(0)}" SessionIndex="_s1"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:Password</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>
</saml:Assertion>
</samlp:Response>`;
  const sig = new SignedXml({
    privateKey: idp.keyPem,
    publicCert: idp.certPem,
    canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#',
    signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
  });
  sig.addReference({
    xpath: "//*[local-name(.)='Assertion']",
    digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
    transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', 'http://www.w3.org/2001/10/xml-exc-c14n#'],
  });
  sig.computeSignature(xml, { location: { reference: "//*[local-name(.)='Assertion']/*[local-name(.)='Issuer']", action: 'after' } });
  let signed = sig.getSignedXml();
  // after signing: change who it says signed in - the signature must catch it
  if (tamper) signed = signed.split(`<saml:AttributeValue>${email}`).join('<saml:AttributeValue>jack.frost@example.com');
  return Buffer.from(signed).toString('base64');
}

let env;
let admin;
let idp;

test.before(async () => {
  env = await startApp({ SANTA_DEMO_MODE: 'true', SANTA_BASE_URL: 'https://santa.example.com' });
  admin = await env.client().init();
  await admin.post('/api/auth/password', { username: 'admin', password: 'admin' });
  idp = testIdentityProvider();
  assert.ok(new crypto.X509Certificate(Buffer.from(idp.b64, 'base64')).subject.includes('Test IdP'));
});
test.after(() => env.close());

test('metadata upload configures everything; bad metadata is refused clearly', async () => {
  const bad = await admin.post('/api/admin/saml/metadata', { xml: '<!DOCTYPE x [<!ENTITY a "b">]><x/>' });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /DOCTYPE/);
  const sp = await admin.post('/api/admin/saml/metadata', { xml: '<EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata" entityID="x"><SPSSODescriptor/></EntityDescriptor>' });
  assert.equal(sp.status, 400);
  assert.match(sp.body.error, /no identity provider/);
  const r = await admin.post('/api/admin/saml/metadata', { xml: metadata(idp) });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.configured, true);
  assert.equal(r.body.enabled, true);
  assert.equal(r.body.idpEntityId, idp.entityId);
  assert.equal(r.body.ssoUrl, idp.ssoUrl);
  assert.equal(r.body.certs.length, 1);
  assert.equal(r.body.sp.acsUrl, 'https://santa.example.com/auth/saml/acs');
  const s = (await (await env.client().init()).get('/api/session')).body;
  assert.equal(s.signIn.sso.url, '/auth/saml/login');
});

test('our own metadata is published for the identity provider', async () => {
  const r = await fetch(`${env.base}/saml/metadata`);
  assert.equal(r.status, 200);
  const xml = await r.text();
  assert.match(xml, /entityID="https:\/\/santa\.example\.com\/saml\/metadata"/);
  assert.match(xml, /Location="https:\/\/santa\.example\.com\/auth\/saml\/acs"/);
});

async function startLogin() {
  const c = await env.client().init();
  const r = await c.req('GET', '/auth/saml/login');
  assert.equal(r.status, 302);
  const loc = new URL(r.headers.get('location'));
  assert.equal(`${loc.origin}${loc.pathname}`, idp.ssoUrl);
  const request = zlib.inflateRawSync(Buffer.from(loc.searchParams.get('SAMLRequest'), 'base64')).toString('utf8');
  const requestId = /ID="([^"]+)"/.exec(request)[1];
  return { c, requestId };
}

async function postResponse(c, SAMLResponse) {
  const r = await fetch(`${env.base}/auth/saml/acs`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ SAMLResponse, RelayState: '' }),
    redirect: 'manual',
  });
  for (const ck of r.headers.getSetCookie()) {
    const [kv] = ck.split(';');
    const i = kv.indexOf('=');
    c.jar[kv.slice(0, i)] = kv.slice(i + 1);
  }
  return r;
}

test('a signed response signs the person in', async () => {
  const { c, requestId } = await startLogin();
  const resp = samlResponse(idp, { requestId, acs: 'https://santa.example.com/auth/saml/acs', audience: 'https://santa.example.com/saml/metadata', email: 'holly.berry@example.com' });
  const r = await postResponse(c, resp);
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/#/');
  const s = (await c.get('/api/session')).body;
  assert.equal(s.user.email, 'holly.berry@example.com');
  // the same response again is refused: its request was already answered
  const again = await postResponse(await env.client().init(), resp);
  assert.match(again.headers.get('location'), /#\/login\?error=azure/);
});

test('a tampered response is refused', async () => {
  const { c, requestId } = await startLogin();
  const resp = samlResponse(idp, { requestId, acs: 'https://santa.example.com/auth/saml/acs', audience: 'https://santa.example.com/saml/metadata', email: 'holly.berry@example.com', tamper: true });
  const r = await postResponse(c, resp);
  assert.match(r.headers.get('location'), /#\/login\?error=azure/);
  assert.equal((await c.get('/api/session')).body.user, null);
});

test('a response for another application, or unsolicited, is refused', async () => {
  const { c, requestId } = await startLogin();
  const wrongAudience = samlResponse(idp, { requestId, acs: 'https://santa.example.com/auth/saml/acs', audience: 'https://other.example/app', email: 'holly.berry@example.com' });
  assert.match((await postResponse(c, wrongAudience)).headers.get('location'), /error=azure/);
  const unsolicited = samlResponse(idp, { requestId: '_never-asked', acs: 'https://santa.example.com/auth/saml/acs', audience: 'https://santa.example.com/saml/metadata', email: 'holly.berry@example.com' });
  assert.match((await postResponse(c, unsolicited)).headers.get('location'), /error=azure/);
});

test('someone not on the list is turned away unless the admin lets the tenant in', async () => {
  let { c, requestId } = await startLogin();
  const resp = samlResponse(idp, { requestId, acs: 'https://santa.example.com/auth/saml/acs', audience: 'https://santa.example.com/saml/metadata', email: 'new.person@example.com', name: 'New Person' });
  assert.match((await postResponse(c, resp)).headers.get('location'), /error=not-invited/);
  await admin.put('/api/admin/settings/auth', { otpEnabled: true, azureEnabled: true, azureAutoProvision: true });
  ({ c, requestId } = await startLogin());
  const resp2 = samlResponse(idp, { requestId, acs: 'https://santa.example.com/auth/saml/acs', audience: 'https://santa.example.com/saml/metadata', email: 'new.person@example.com', name: 'New Person' });
  assert.equal((await postResponse(c, resp2)).headers.get('location'), '/#/');
  assert.equal((await c.get('/api/session')).body.user.name, 'New Person');
});
