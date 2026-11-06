# 🎅 Secret Santa

A Christmas-themed Secret Santa web app that anyone can use: **create a game** for your team,
or **join one** with an invite link or code. Draws stay within each location, players see only
their own child and that child's wishlist, and there are gifts (many small ones plus a final
one), public fun tasks, anonymous Santa notes, gentle reminder emails and a demo mode. Sign-in
is by SAML or Microsoft (Entra ID) single sign-on, email codes, or a password.

Node 24 with its built-in SQLite and three exact-pinned npm dependencies (nodemailer, node-saml,
xmldom). No front-end build step: plain HTML, CSS and JavaScript modules.

## Run it

| where | command | then open |
|---|---|---|
| a Docker host at home | `docker compose --env-file home.env up --build -d` | `SANTA_BASE_URL` from home.env |
| a Docker host at work | `docker compose --env-file work.env up --build -d` | `SANTA_BASE_URL` from work.env |
| a developer machine, demo data | `npm start -- --demo` | http://localhost:8080 |

`admin` / `admin` is the seeded platform admin. With real data (demo mode off) it must be
changed at the first sign-in before anything else works. Locked out? This puts `admin` /
`admin` back (change it at the next sign-in) - run as the owner of the data folder, and with the
env file, like every compose command here:

```bash
docker compose --env-file home.env exec --user "$(stat -c %u:%g ./data)" secret-santa node server/index.js --reset-admin
```

### Demo mode

`SANTA_DEMO_MODE=true` in the env file:

* made-up people, locations and three games, each with its own organiser (one in full swing,
  one still being set up with uneven locations, one finished and revealed), with wishlists,
  gifts, tasks, notes, people sitting out and people on Do not disturb;
* every email sign-in code is `SANTA_DEMO_OTP` (default `123456`), and the sign-in page lists
  every demo person so you can play as anyone with one click; `admin` / `admin` works too;
* **no email ever leaves the app** - everything lands in Admin > Outbox, sealed like real game
  emails; Admin > Email has a preview of each one. ("Send a test email" there is the one exception
  that really sends, so you can try a relay.)
* Admin > Overview has **Reset the demo**.

Demo data lives in its own database file, `demo.sqlite`. With `SANTA_DEMO_MODE=false` the app
opens `santa.sqlite` instead, so **no demo record can ever be visible with demo mode off**, and
switching back and forth never touches real data. Change the value and run the same `up`
command again.

## Who does what

| role | can |
|---|---|
| **player** | everyone who signs in. Sees the games they are part of on the home page, joins more with an invite link or code (or from "Open for sign-ups"), checks in, keeps a wishlist and hints, gives gifts, sets tasks, sends notes |
| **organiser** | whoever **creates a game** owns it: dates, budget, players, locations, exclusions, the draw, reminders and the reveal - and can open the **Santa list**, the only place all the pairs are shown (blurred until unsealed, and every look is in the audit log). Organisers only ever see the games they organise |
| **platform admin** | runs the platform, not the games: people and CSV import, locations, sign-in (SAML, Microsoft, email codes, who may sign up), email relay, guidelines, the audit log. For a game the admin sees its name, organiser, status, dates and number of players, and can hand it to one of its players or delete it - nothing about who plays or who drew whom |

**These are two separate roles.** An admin account cannot create, join, play in or open a game; a
person who wants to do both uses two accounts (the seeded `admin` for the platform, their own
for the games). Someone in a running game cannot be made an admin.

**An organiser can play in their own game** - but since they run the draw, the app asks them to
accept, once, that they will be able to see who their own Santa is. Their acceptance is
recorded (and asked again if the game is handed to someone else). Without it they organise
from the sidelines.

## Creating and joining a game

* **Create a game** (home page): name, dates, budget, "within each location" or "everyone
  together", the smallest comfortable group, reveal automatically or by hand, optional open
  sign-up, and "I'm playing too". A new game can copy the players of a game you organised before
  and exclude last year's pairs.
* **Invite people**: every game has an invite link (`/#/join/<code>`) and a 10-character code on
  its Players tab. Anyone signed in can join with either; a new code turns the old one off. The
  organiser can also add people by searching for them, or everyone from a location. People added
  this way see the game on their home page and can sit it out; their wishlist and hints reach their
  Santa once they say yes (see [Privacy and security](#privacy-and-security)).
* **Sign-up for newcomers**: with Admin > Sign-in > **Open sign-up** on (optionally limited
  to some email domains), someone who is not yet on the list gets a sign-in code, and their
  account is created only once they type it in. An invite link they open first is kept and
  carried through sign-in.

## How a game works

Every game moves through four phases, shown as a timeline at the top of its page:

| phase | players | organiser |
|---|---|---|
| **1. Check in** (until the game's *check-in date*) | confirm where they play from - or press **Sit this one out** | sees who has checked in; gentle reminders go out automatically on the game's *reminder days* (default 3 days and 1 day before), or by hand with "Send a gentle check-in nudge" |
| **2. Names drawn** | see their child | draws names; whoever sits out is left out |
| **3. Gift giving** (start - end date) | log gifts and tasks, send notes | a friendly "jingle" goes to Santas without a final gift on the reminder days before the end (or by hand) |
| **4. The big reveal** | see who their Santa was | automatic after the end, or by hand |

All reminders are deliberately soft: no deadlines shouted, no "you haven't...", a reminder that
sitting out is fine, and a link to **Do not disturb** at the bottom. Anyone on Do not disturb
(About me) gets **no** email except a sign-in code they asked for; the app still shows them
everything. A round goes out once - if the server was down on the day, only the latest missed
round is sent. Moving a date or changing the reminder days starts the rounds over.

**Sitting out** is possible until names are drawn; the person stays in the list (greyed, "🛋️
sitting out"), is not counted in the location balance, is never drawn and never emailed about
that game, and can count themselves back in. After the draw the organiser removes them instead.

**Guidelines**: Admin > Guidelines holds the "How to play" page every player sees (a small
Markdown subset: `#` headings, `-` and `1.` lists, `**bold**`, `*italic*`, links). Each game can
add its own house rules in its settings; they show on the game page.

### Setting up the draw

1. **Players & locations** - the **location balance** shows every group:
   * ⛔ red: a location with one person (cannot be matched) or people with no location - the
     draw is blocked until it is fixed;
   * ⚠️ amber: a location with two people (they would just swap) or below the game's minimum;
   * fix it by **merging** a location into another for this game, moving one person into
     another location's draw, or matching everyone together.

   Odd numbers are fine: each group is drawn as one random circle (A → B → C → A), so nobody
   draws themselves, nobody simply swaps when there are three or more, and any size works.
   The home page shows each organiser the same warnings for every game they run.
2. **Exclusions** - pairs who must not draw each other (partners, a manager and their report).
3. **Draw names** - optionally emails every Santa that they have been matched (the name stays in the app). Late joiners can be **inserted**
   into the circle afterwards (only one Santa's child changes); removing someone hands their
   child to their Santa so the circle stays whole.

Players see **only their own child** - name, location, hints and wishlist - never anyone else's
wishlist and never their own Santa, until the reveal. They log gifts (any number, one marked as
the **final gift**), set **fun tasks** that appear on the game's public task board (with the
child's name, never the Santa's), and exchange anonymous notes. Children mark gifts received
with a thank-you and tasks done; everyone can cheer tasks on.

The organiser's full Santa list is blurred until unsealed, and every look at it is in the audit
log.

### People in bulk

**Admin > Import CSV** loads people for the whole platform. Required columns `userName`, `ID`,
`email`; optional `location`. Header names are flexible (`Employee ID`, `E-mail Address`,
`Office` ...). The file is checked first and shows what will be created, updated or skipped;
re-importing updates people instead of duplicating them. Template: `sample/people.csv`.

## Sign-in

* **SAML 2.0 (Microsoft Entra ID, Okta, ADFS ...)** - Admin > Sign-in > SAML: upload the
  identity provider's **federation metadata XML** (or paste it, or give its URL) and the app
  configures itself - entity ID, sign-in URL and signing certificates, with each certificate's
  subject and expiry shown. A metadata URL is re-read daily, so certificate rollover needs no
  action. Give the identity provider the app's side from the same page: the SP Entity ID
  (default `<SANTA_BASE_URL>/saml/metadata`), the reply / ACS URL
  (`<SANTA_BASE_URL>/auth/saml/acs`), or simply the downloadable SP metadata. Signed assertions
  are required; the issuer, audience, time window and InResponseTo are all checked, and a
  response is accepted once. People are matched by the email claim (Entra's email or UPN claims
  work out of the box). Entra needs an `https://` reply URL (plain http only for localhost).
* **Microsoft OpenID Connect** - an alternative to SAML for Entra: register a *Web* application
  with the redirect URI `<SANTA_BASE_URL>/auth/azure/callback`, put the tenant and client id in
  the env file (`SANTA_AZURE_TENANT_ID`, `SANTA_AZURE_CLIENT_ID`) and the client secret, alone,
  in `SANTA_SECRETS_DIR/azure_client_secret`. Code flow with PKCE; the ID token's signature,
  issuer, audience, expiry and nonce are all checked. When both are set up, the sign-in button
  uses SAML.
* **Who may get in** - either single sign-on can create accounts for anyone the identity
  provider vouches for ("Let anyone from single sign-on join"), or admit only people already on the list. **Open sign-up**
  (optionally only some domains) does the same for email codes.
* **Email code** - 6 digits, valid 10 minutes, 5 tries, rate limited; the answer never reveals
  whether an address is on the list. The outbox keeps a copy with the code blanked out.
* **Password** - the seeded `admin`, and anyone an admin gives a password (People > Edit).

## Privacy and security

What the app guarantees, each one checked by `test/attacks.test.js`:

* **Every route, the wrong people.** The attack tests read the router's own route list (so a new
  route is covered automatically) and call every route as someone who must get nowhere -
  signed out, a stranger, a player of another game, a player of the same game, the organiser of
  another game, the platform admin - with real ids filled in and tampered values in the body.
  Every answer must be a refusal and the database must be unchanged afterwards.
* **A child never learns their Santa** before the reveal: no field, gift, task, note, board
  entry, count or email gives it away. The child's side of the notes follows the child, so
  even a change of Santa (a late joiner slotted in, someone taken out) leaves no trace.
* **A Santa sees only their own child**, and a child's wishlist and hints reach that Santa only
  once the child has **said yes** to the game. Anyone can create a game and add anyone, so
  being added is not consent: joining by invite or sign-up, checking in, counting yourself in,
  or playing as the organiser is. The match email leaves the wishlist out until then too.
* **The platform admin cannot learn the pairings.** An admin account is refused every game
  route. Game emails are **sealed** in the outbox, in demo mode too: the admin sees each one's
  subject (which never names a child) and whether it arrived, never who received it - that alone
  could give a pair away when someone is slotted in - or what it says, and the body is deleted
  once sent (sign-in codes are stored blanked). An admin account cannot be made organiser of a
  game; a game with players can only be handed to one of them; and an admin cannot change the
  email or password of anyone in a still-secret draw, by hand or by CSV. Deleting a person
  does not say who they were paired with.
* **No harvesting.** The people search needs two letters, answers at most 25 people with masked
  addresses (`ho•••@example.com`), matches an email only when typed in full, and is rate
  limited. Organisers never see a full address or an employee ID; players see no addresses.
* **No guessing.** Every API caller has a request budget (per person and per address), and
  refusals - asking for a game, gift, task, person or invite code that does not exist or is not
  yours - lock the caller out after 40 in 10 minutes. Sign-in codes die after 5 wrong tries,
  and an address takes at most 15 wrong codes a day; a known address answers exactly like an
  unknown one, in the same time. Passwords lock after 8 wrong tries from one address. Team
  emails an organiser sends by hand are capped per game and per organiser.
* **No peeking.** On screen, the child's name is hidden like a password: dots and a
  **Hold to peek** button that shows it only while held (mouse, finger, or Space / Enter) and
  hides it on release, when the window loses focus or the tab is hidden. While hidden the name is
  not in the page at all, so find-in-page and copy cannot reach it. **No email ever names a
  Santa's child**: the match email says only that they have been matched, and the app shows who
  (no name, location or wishlist in the match, start, reminder or note emails).

What it cannot promise: whoever runs the **server** or controls **sign-in** (the platform admin
can point SAML at an identity provider of their choosing) can always act as someone else. Keep
that role to people you would trust with the Santa list anyway. Limits are kept in memory, so
a restart resets them. Game names are unique across the platform, so creating a game shows
whether a name is taken.

## Look and feel

Frosted-glass panels over a winter night (or a snowy day in light mode), snowfall on by default
(the ❄️ button turns it off and the choice is remembered; with "reduce motion" it drifts slowly
and sparsely), headings in **Mountains of Christmas** and body text in **Nunito**, both served
from the app itself - no font CDN, nothing loaded from a third party. Every page reflows from a
phone (tables become cards below 760px) to a wide screen. The fonts keep their own licences
(Apache 2.0 and SIL OFL 1.1, in `public/fonts`).

## Email

Admin > Email: an **open relay** (host, port, none / STARTTLS / TLS, From, Reply-To - no
username or password is stored), a test button, which notifications go out, and previews of
every template. Emails are queued in the outbox and sent in the background; failed ones can be
retried. The public address used in links comes from Admin > Email or `SANTA_BASE_URL`.

## Deployment

`docker-compose.yml` bakes in no site location: every location is required from the env file
(`${VAR?}`), an empty value means "off". `work.env` holds **avro.com placeholders** - replace
them on the work machine with the real registry prefix, apt mirror, npm registry and proxy, and
never commit those values. `home.env` uses the public registries with no proxy; set its
`SANTA_BASE_URL` to your own host.

| key | meaning |
|---|---|
| `IMAGE_REGISTRY`, `APT_MIRROR`, `NPM_REGISTRY`, `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` | where the build downloads from |
| `RUNTIME_HTTPS_PROXY` | proxy for the running app (Microsoft sign-in and SAML metadata URLs only; SMTP never uses it) |
| `SANTA_DEMO_MODE`, `SANTA_DEMO_OTP` | demo mode and its sign-in code |
| `SANTA_PORT`, `SANTA_BIND`, `SANTA_BASE_URL` | host networking: where it listens, the address people type |
| `SANTA_TLS_SELF_SIGNED`, `SANTA_TLS_HOSTNAME` | make a self-signed certificate on first start until the real `tls.crt` / `tls.key` are dropped into `SANTA_TLS_DIR` (picked up without a restart) |
| `SANTA_TRUST_PROXY` | `true` only behind a reverse proxy on the same host |
| `SANTA_AZURE_TENANT_ID`, `SANTA_AZURE_CLIENT_ID` | Microsoft OpenID Connect sign-in (empty = off) |
| `SANTA_DATA_DIR`, `SANTA_TLS_DIR`, `SANTA_SECRETS_DIR` | bind mounts; at work outside the code folder so a new copy of the code never touches them |
| `TZ` | the time zone game dates are judged in |

The image: Ubuntu 24.04 (pinned by digest) with the official Node 24 binary copied in from the
pinned Node image, a non-root user, read-only root filesystem, all capabilities dropped except
those the entrypoint needs to fix bind-mount ownership before it drops privileges. Classic
builder only (no BuildKit syntax). A site CA for a TLS-inspecting proxy goes in `certs/*.crt`.
An npm token, if a registry needs one, is given for one command only:
`NPM_TOKEN=... docker compose --env-file work.env up --build -d`.

**72-hour supply-chain gate**: `npm ci` from the lockfile, then
`scripts/check-release-age.js --offline` refuses any package published less than 72 hours
before, judged from the committed `deps-publish-times.json` (refresh with
`npm run deps:age`). Image pins and their push dates are in `image-pins.json`.

Back up `SANTA_DATA_DIR` (`santa.sqlite`); that is all the state there is.

## Tests

`npm test` - the draw rules, CSV parsing, the whole API with a fake mail relay catching real
sign-in codes (who can see what, the date window, gifts, tasks, notes, reveal, late joiners,
dropouts, check-in and reminders), game ownership (organisers only reach their own games, the
spoiler acknowledgement, invite codes, the admin's limits), SAML end to end with a signed
response from a test identity provider (and tampered, replayed, wrong-audience and unsolicited
ones refused), demo-mode isolation, guards for every deployment rule above, and the attack
tests described under [Privacy and security](#privacy-and-security).

## Licence

[MIT](LICENSE). The bundled fonts keep their own licences (see `public/fonts/README.md`).
