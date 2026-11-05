'use strict';
// SAML 2.0 single sign-on - for example a Microsoft Entra ID "Enterprise
// application". The admin uploads (or pastes, or gives the URL of) the
// identity provider's federation metadata XML; the app reads the IdP entity ID,
// its sign-in URL and its signing certificate(s) from it and configures itself.
// Nothing secret is involved: the certificates are public.
//
// The response is validated by @node-saml/node-saml (the library behind
// passport-saml): XML signature over the assertion with the IdP's certificate,
// audience, issuer, time window, and InResponseTo against a request we sent.
const crypto = require('node:crypto');
const { DOMParser } = require('@xmldom/xmldom');
const { SAML, ValidateInResponseTo } = require('@node-saml/node-saml');
const { nowIso } = require('../lib/util');

const MD = 'urn:oasis:names:tc:SAML:2.0:metadata';
const DS = 'http://www.w3.org/2000/09/xmldsig#';
const REDIRECT = 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect';
const REQUEST_TTL = 10 * 60e3;

const CLAIMS = {
  email: [
    'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
    'email', 'mail', 'urn:oid:0.9.2342.19200300.100.1.3',
  ],
  upn: ['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/upn', 'upn'],
  displayName: ['http://schemas.microsoft.com/identity/claims/displayname', 'displayName', 'displayname'],
  given: ['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname', 'givenName'],
  surname: ['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname', 'sn', 'surname'],
};

const toPem = (b64) => `-----BEGIN CERTIFICATE-----\n${b64.match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`;

function certInfo(b64) {
  const c = new crypto.X509Certificate(Buffer.from(b64, 'base64'));
  return {
    subject: c.subject.replace(/\n/g, ', '),
    validFrom: new Date(c.validFrom).toISOString(),
    validTo: new Date(c.validTo).toISOString(),
    fingerprint: c.fingerprint256,
  };
}

// Read an IdP's metadata. Throws a plain-English error for anything unusable.
function parseMetadata(xml) {
  const text = String(xml || '').replace(/^﻿/, '').trim();
  if (!text) throw new Error('The metadata is empty');
  if (text.length > 2 * 1024 * 1024) throw new Error('That file is too large to be SAML metadata');
  // No DTDs at all: closes the door on entity-expansion and external-entity tricks.
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error('Metadata with a DOCTYPE is not accepted');
  const problems = [];
  const doc = new DOMParser({
    onError: (level, msg) => { if (level !== 'warning') problems.push(msg); },
    errorHandler: { warning() {}, error: (m) => problems.push(m), fatalError: (m) => problems.push(m) },
  }).parseFromString(text, 'text/xml');
  if (problems.length || !doc || !doc.documentElement) throw new Error('That is not valid XML');
  const entities = Array.from(doc.getElementsByTagNameNS(MD, 'EntityDescriptor'));
  if (!entities.length) throw new Error('No EntityDescriptor found - is this SAML metadata (Federation Metadata XML)?');
  let entity = null;
  let idp = null;
  for (const e of entities) {
    const d = e.getElementsByTagNameNS(MD, 'IDPSSODescriptor')[0];
    if (d) { entity = e; idp = d; break; }
  }
  if (!idp) throw new Error('This metadata describes no identity provider (no IDPSSODescriptor) - download the IdP metadata, not a service provider one');
  const entityId = entity.getAttribute('entityID');
  if (!entityId) throw new Error('The metadata has no entityID');
  const sso = Array.from(idp.getElementsByTagNameNS(MD, 'SingleSignOnService'));
  const redirect = sso.find((x) => x.getAttribute('Binding') === REDIRECT);
  if (!redirect || !/^https:\/\//i.test(redirect.getAttribute('Location') || '')) {
    throw new Error('The metadata has no HTTPS single sign-on address for the HTTP-Redirect binding');
  }
  const certs = [];
  for (const kd of Array.from(idp.getElementsByTagNameNS(MD, 'KeyDescriptor'))) {
    const use = kd.getAttribute('use');
    if (use && use !== 'signing') continue;
    for (const c of Array.from(kd.getElementsByTagNameNS(DS, 'X509Certificate'))) {
      const b64 = String(c.textContent || '').replace(/\s+/g, '');
      if (b64 && !certs.includes(b64)) certs.push(b64);
    }
  }
  if (!certs.length) throw new Error('The metadata has no signing certificate');
  const info = certs.map((b64) => {
    try { return certInfo(b64); } catch { throw new Error('A signing certificate in the metadata could not be read'); }
  });
  return { entityId, ssoUrl: redirect.getAttribute('Location'), certs, certInfo: info };
}

function create(app) {
  // Request IDs we sent, so a response must answer one of them (InResponseTo),
  // shared by every SAML object we build. One process, so memory is enough.
  const requests = new Map();
  const sweep = () => { for (const [k, v] of requests) if (Date.now() - v.createdAt > REQUEST_TTL) requests.delete(k); };
  const cacheProvider = {
    async saveAsync(key, value) {
      sweep();
      if (requests.has(key)) return null;
      const item = { value, createdAt: Date.now() };
      requests.set(key, item);
      return item;
    },
    async getAsync(key) {
      const v = requests.get(key);
      if (!v || Date.now() - v.createdAt > REQUEST_TTL) { requests.delete(key); return null; }
      return v.value;
    },
    async removeAsync(key) {
      if (key === null) return null;
      const v = requests.get(key);
      requests.delete(key);
      return v ? v.value : null;
    },
    async takeAsync(key) {
      const v = requests.get(key);
      requests.delete(key);
      return v && Date.now() - v.createdAt <= REQUEST_TTL ? v.value : null;
    },
  };

  const cfg = () => app.settings.read('saml');
  const spEntityId = () => cfg().spEntityId || `${app.publicUrl()}/saml/metadata`;
  const acsUrl = () => `${app.publicUrl()}/auth/saml/acs`;

  function status() {
    const c = cfg();
    const missing = [];
    if (!c.ssoUrl || !c.certs.length) missing.push('the identity provider metadata');
    if (!app.publicUrl()) missing.push('the public address (SANTA_BASE_URL)');
    return {
      configured: missing.length === 0,
      enabled: Boolean(c.enabled),
      missing,
      idpEntityId: c.idpEntityId,
      ssoUrl: c.ssoUrl,
      certs: c.certs.map((b64) => { try { return certInfo(b64); } catch { return { subject: 'unreadable' }; } }),
      metadataUrl: c.metadataUrl,
      configuredAt: c.configuredAt,
      refreshedAt: c.refreshedAt,
      emailAttribute: c.emailAttribute,
      buttonLabel: c.buttonLabel,
      sp: { entityId: spEntityId(), acsUrl: acsUrl(), metadataUrl: `${app.publicUrl()}/saml/metadata` },
    };
  }

  const available = () => {
    const s = status();
    return s.configured && s.enabled;
  };

  function instance() {
    const c = cfg();
    return new SAML({
      entryPoint: c.ssoUrl,
      issuer: spEntityId(),
      callbackUrl: acsUrl(),
      audience: spEntityId(),
      idpIssuer: c.idpEntityId || undefined,
      idpCert: c.certs.map(toPem),
      identifierFormat: null,
      wantAssertionsSigned: true,
      // Entra ID signs the assertion by default, not the whole response.
      wantAuthnResponseSigned: false,
      acceptedClockSkewMs: 3 * 60e3,
      validateInResponseTo: ValidateInResponseTo.always,
      requestIdExpirationPeriodMs: REQUEST_TTL,
      cacheProvider,
      disableRequestedAuthnContext: true,
      signatureAlgorithm: 'sha256',
    });
  }

  async function loginUrl() {
    if (!available()) throw new Error('SAML sign-in is not set up');
    return instance().getAuthorizeUrlAsync('', undefined, {});
  }

  const first = (profile, names) => {
    for (const n of names) {
      const v = profile[n];
      const s = Array.isArray(v) ? v[0] : v;
      if (typeof s === 'string' && s.trim()) return s.trim();
    }
    return '';
  };

  // Validate the POSTed response and say who signed in.
  async function finish(body) {
    if (!available()) throw new Error('SAML sign-in is not set up');
    if (!body.SAMLResponse) throw new Error('The sign-in response is missing');
    const { profile } = await instance().validatePostResponseAsync({ SAMLResponse: String(body.SAMLResponse), RelayState: String(body.RelayState || '') });
    if (!profile) throw new Error('The identity provider did not sign anyone in');
    const c = cfg();
    const custom = c.emailAttribute ? first(profile, [c.emailAttribute]) : '';
    const email = (custom || first(profile, CLAIMS.email) || (/@/.test(profile.nameID || '') ? profile.nameID : '')).toLowerCase();
    const upn = first(profile, CLAIMS.upn).toLowerCase();
    const display = first(profile, CLAIMS.displayName) || [first(profile, CLAIMS.given), first(profile, CLAIMS.surname)].filter(Boolean).join(' ');
    return { email: email || upn, username: upn || email, name: display, oid: profile.nameID };
  }

  // Our own (service provider) metadata, for the identity provider.
  function spMetadata() {
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    return `<?xml version="1.0" encoding="UTF-8"?>
<md:EntityDescriptor xmlns:md="${MD}" entityID="${esc(spEntityId())}">
  <md:SPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol" AuthnRequestsSigned="false" WantAssertionsSigned="true">
    <md:NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</md:NameIDFormat>
    <md:AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${esc(acsUrl())}" index="1" isDefault="true"/>
  </md:SPSSODescriptor>
</md:EntityDescriptor>
`;
  }

  // Configure from metadata (XML text, or a URL to fetch it from).
  async function configure({ xml, url }) {
    let text = xml;
    let fromUrl = '';
    if (!text && url) {
      fromUrl = String(url).trim();
      if (!/^https:\/\//i.test(fromUrl)) throw new Error('The metadata address must start with https://');
      const r = await fetch(fromUrl, { signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error(`Fetching the metadata failed: ${r.status} ${r.statusText}`);
      text = await r.text();
    }
    const m = parseMetadata(text);
    const c = cfg();
    app.settings.write('saml', {
      idpEntityId: m.entityId,
      ssoUrl: m.ssoUrl,
      certs: m.certs,
      metadataUrl: fromUrl || (xml ? '' : c.metadataUrl),
      configuredAt: nowIso(),
      refreshedAt: nowIso(),
      // the first configuration fixes our entity ID, so a later change of
      // the public address does not silently break the IdP's registration
      spEntityId: c.spEntityId || spEntityId(),
      enabled: c.configuredAt ? c.enabled : true,
    });
    return { ...m, status: status() };
  }

  // Certificates roll over: re-read the metadata URL once a day when we have one.
  async function refresh() {
    const c = cfg();
    if (!c.metadataUrl || (c.refreshedAt && Date.now() - Date.parse(c.refreshedAt) < 23 * 3600e3)) return false;
    try {
      await configure({ url: c.metadataUrl });
      return true;
    } catch (err) {
      console.error(`saml metadata refresh: ${err.message}`);
      return false;
    }
  }

  return { status, available, loginUrl, finish, spMetadata, configure, refresh, parseMetadata };
}

module.exports = { create, parseMetadata, CLAIMS };
