'use strict';
// Settings an admin changes in the app, stored as JSON per section. Every read
// merges with the defaults, so a section added in a later release has values
// even in a database written by an earlier one.

const DEFAULTS = {
  general: {
    appTitle: 'Secret Santa',
    // Where links in emails point. Empty = SANTA_BASE_URL from the env file.
    baseUrl: '',
    currencyHint: '',
  },
  email: {
    // An open relay: no username or password is ever stored.
    host: '',
    port: 25,
    security: 'none', // none | starttls | tls
    allowInvalidCert: false,
    fromName: 'Secret Santa',
    fromEmail: '',
    replyTo: '',
  },
  auth: {
    otpEnabled: true,
    azureEnabled: true,
    // Let anyone in the Azure tenant sign in, creating an account on first
    // visit. Off: only people already loaded (CSV or by hand) can sign in.
    azureAutoProvision: false,
    // Anyone with an email address may sign up with a code (the platform is open
    // to all); optionally only from these domains, e.g. "avro.com, example.org".
    selfSignup: false,
    signupDomains: '',
  },
  // SAML single sign-on, configured from the identity provider's metadata XML
  // (uploaded, pasted, or fetched from its URL). Certificates are public; SAML
  // needs no secret on our side.
  saml: {
    enabled: false,
    idpEntityId: '',
    ssoUrl: '',
    certs: [],
    metadataUrl: '',
    configuredAt: '',
    refreshedAt: '',
    spEntityId: '',
    emailAttribute: '',
    buttonLabel: 'Sign in with Microsoft',
  },
  notifications: {
    matched: true,
    taskAssigned: true,
    giftLogged: true,
    messages: true,
    start: true,
    reveal: true,
    // Gentle automatic nudges, sent the days before a team's deadlines
    // (the team's "reminder days"): check in with your location (phase 1),
    // and a little jingle before the game ends (phase 2).
    locationReminder: true,
    giftReminder: true,
  },
  // "How to play": the organiser's guidelines, shown to everyone. A small
  // Markdown subset (# headings, - lists, **bold**, *italic*, [links](https://...)).
  guidelines: {
    text: `# Welcome to the North Pole workshop! 🎄

Secret Santa is all about fun - there is no pressure, no scoreboard and no wrong way to play.

## How it works
1. **Check in.** Tell us where you're playing from before the check-in date, so you get a Santa buddy nearby.
2. **Names are drawn.** You'll see who your child is - and only them. Your own Santa stays a mystery.
3. **Spread some cheer.** Leave small surprises during the game, and one final gift at the end. Log them in the app so your child gets a happy ping.
4. **Fun tasks.** Set your child a silly, kind challenge. Everyone can see the task board (but never who set it).
5. **The big reveal.** After the last day, everyone finds out who their Santa was.

## Kindness rules
- Keep gifts and tasks kind, inclusive and safe for work.
- Stick to the budget - it's the thought that counts.
- Check your child's hints for allergies and dislikes.
- Not up for it this year? Press **Sit this one out** before names are drawn. No questions asked. 💛
- Too many emails? Switch on **Do not disturb** under *About me*.

Have fun, and happy holidays! ✨`,
  },
};

function create(db) {
  const read = (section) => {
    const row = db.get('SELECT value FROM settings WHERE key = ?', section);
    let stored = {};
    if (row) {
      try { stored = JSON.parse(row.value); } catch { stored = {}; }
    }
    return { ...DEFAULTS[section], ...stored };
  };
  const write = (section, values) => {
    if (!DEFAULTS[section]) throw new Error(`unknown settings section ${section}`);
    const merged = { ...read(section) };
    for (const k of Object.keys(DEFAULTS[section])) {
      if (values[k] !== undefined) merged[k] = values[k];
    }
    db.run(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      section, JSON.stringify(merged),
    );
    return merged;
  };
  return { read, write, DEFAULTS };
}

module.exports = { create, DEFAULTS };
