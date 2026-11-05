'use strict';
// Every email the app sends, as { subject, html, text }. Inline styles and
// table layout throughout, because that is what mail clients (Outlook above
// all) actually render; the striped header falls back to plain red where
// gradients are not supported.

const esc = (s) => String(s === undefined || s === null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const nl2br = (s) => esc(s).replace(/\n/g, '<br>');

function fmtDate(d) {
  if (!d) return '';
  const dt = new Date(`${d}T00:00:00Z`);
  if (Number.isNaN(dt.getTime())) return d;
  return dt.toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

const FONT = "Arial, 'Helvetica Neue', Helvetica, sans-serif";
const SERIF = "Georgia, 'Times New Roman', serif";

function layout({ appTitle, emoji, title, preheader, body, cta, footer, profileLink }) {
  const button = cta && cta.url ? `
          <tr><td align="center" style="padding:4px 32px 32px;">
            <table role="presentation" cellpadding="0" cellspacing="0"><tr>
              <td style="background:#146b3a;border-radius:999px;box-shadow:0 3px 0 #0b4426;">
                <a href="${esc(cta.url)}" style="display:inline-block;padding:14px 30px;font-family:${FONT};font-size:16px;font-weight:bold;color:#ffffff;text-decoration:none;">${esc(cta.label)} &rarr;</a>
              </td></tr></table>
          </td></tr>` : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"><title>${esc(title)}</title></head>
<body style="margin:0;padding:0;background:#efe7da;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${esc(preheader || '')}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#efe7da;">
    <tr><td align="center" style="padding:24px 12px;">
      <div style="font-family:${FONT};font-size:18px;letter-spacing:10px;color:#b3001b;padding-bottom:8px;">&#10052; &#10053; &#10054; &#10052; &#10053;</div>
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#fffdf8;border-radius:18px;overflow:hidden;border:1px solid #e6dccb;">
        <tr><td align="center" bgcolor="#b3001b" style="background-color:#b3001b;background-image:repeating-linear-gradient(135deg,#b3001b 0,#b3001b 16px,#c8102e 16px,#c8102e 32px);padding:30px 24px 26px;color:#ffffff;">
          <div style="font-size:44px;line-height:1;">${emoji || '&#127877;'}</div>
          <div style="font-family:${SERIF};font-size:27px;line-height:1.25;font-weight:bold;margin-top:10px;">${esc(title)}</div>
          <div style="font-family:${FONT};font-size:12px;letter-spacing:3px;text-transform:uppercase;margin-top:8px;color:#ffe9b0;">&#10052; ${esc(appTitle)} &#10052;</div>
        </td></tr>
        <tr><td style="height:7px;line-height:7px;font-size:0;background:#f2b632;">&nbsp;</td></tr>
        <tr><td style="padding:28px 32px 20px;font-family:${FONT};font-size:16px;line-height:1.6;color:#2d2a26;">
          ${body}
        </td></tr>
        ${button}
        <tr><td align="center" style="background:#146b3a;padding:16px 24px;font-family:${FONT};font-size:12px;line-height:1.5;color:#d9efe1;">
          &#127876; ${footer ? esc(footer) : 'Keep it secret, keep it merry.'} &#127876;
        </td></tr>
      </table>
      <div style="font-family:${FONT};font-size:11px;line-height:1.6;color:#8a7f70;padding-top:12px;">You get this because you are playing in ${esc(appTitle)}.${profileLink ? `<br>Prefer a quieter inbox? Switch on <a href="${esc(profileLink)}" style="color:#8a7f70;">Do not disturb</a> - you can still see everything in the app.` : ''}</div>
    </td></tr>
  </table>
</body></html>`;
}

// A dashed "gift tag" panel used to make one thing stand out.
const tag = (label, value, sub) => `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:18px 0;">
    <tr><td align="center" style="border:2px dashed #f2b632;border-radius:14px;background:#fff7e0;padding:18px 16px;">
      <div style="font-family:${FONT};font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#8a6a00;">${esc(label)}</div>
      <div style="font-family:${SERIF};font-size:28px;font-weight:bold;color:#b3001b;margin-top:6px;">${esc(value)}</div>
      ${sub ? `<div style="font-family:${FONT};font-size:14px;color:#5b544a;margin-top:4px;">${esc(sub)}</div>` : ''}
    </td></tr>
  </table>`;

const quote = (s) => `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:14px 0;">
    <tr><td style="border-left:4px solid #146b3a;background:#eef6f0;border-radius:6px;padding:12px 16px;font-family:${FONT};font-size:15px;color:#2d2a26;">${nl2br(s)}</td></tr>
  </table>`;

const facts = (rows) => `
  <table role="presentation" cellpadding="0" cellspacing="0" style="margin:10px 0 4px;font-family:${FONT};font-size:14px;color:#2d2a26;">
    ${rows.filter((r) => r[1]).map(([k, v]) => `<tr><td style="padding:3px 14px 3px 0;color:#7a6f60;white-space:nowrap;">${esc(k)}</td><td style="padding:3px 0;font-weight:bold;">${esc(v)}</td></tr>`).join('')}
  </table>`;

function textOf(lines) {
  return `${lines.filter((l) => l !== null && l !== undefined).join('\n')}\n`;
}

// ---- templates ---------------------------------------------------------------

function otp({ appTitle, name, code, minutes = 10, demo = false }) {
  const spaced = String(code).replace(/(\d{3})(?=\d)/g, '$1 ');
  return {
    subject: `${code} is your ${appTitle} sleigh pass`,
    html: layout({
      appTitle,
      emoji: '&#128273;',
      title: 'Your sleigh pass is here!',
      preheader: `Your sign-in code is ${code}. It melts in ${minutes} minutes.`,
      body: `
        <p style="margin:0 0 10px;">Ho ho hello${name ? `, <b>${esc(name)}</b>` : ''}! &#9924;</p>
        <p style="margin:0 0 6px;">Someone (hopefully you!) asked to sign in. Pop this code into the page:</p>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:18px 0;">
          <tr><td align="center" style="background:#0f3d24;border-radius:14px;padding:20px 10px;">
            <div style="font-family:'Courier New',Courier,monospace;font-size:38px;letter-spacing:8px;font-weight:bold;color:#ffffff;">${esc(spaced)}</div>
            <div style="font-family:${FONT};font-size:12px;color:#bfe3cc;margin-top:6px;">melts in ${minutes} minutes &#10052;</div>
          </td></tr>
        </table>
        ${demo ? `<p style="margin:0;color:#8a6a00;"><b>Demo mode:</b> every code is ${esc(code)}.</p>` : ''}
        <p style="margin:0;font-size:13px;color:#7a6f60;">Didn't ask for this? No reindeer games needed - just ignore it. Nobody can sign in without the code.</p>`,
      footer: 'Never share your code - not even with an elf.',
    }),
    text: textOf([`Ho ho hello${name ? `, ${name}` : ''}!`, '', `Your ${appTitle} sign-in code is: ${code}`, `It melts in ${minutes} minutes.`, '', "Didn't ask for this? Just ignore it."]),
  };
}

function matched({ profileLink, appTitle, santaName, childName, childLocation, teamName, budget, startDate, endDate, wishlist = [], link }) {
  const wishes = wishlist.slice(0, 5);
  const wishHtml = wishes.length ? `
    <p style="margin:16px 0 6px;font-weight:bold;">&#127873; A peek at their wishlist</p>
    <ul style="margin:0 0 8px;padding-left:20px;">
      ${wishes.map((w) => `<li style="margin:3px 0;">${w.url ? `<a href="${esc(w.url)}" style="color:#146b3a;">${esc(w.title)}</a>` : esc(w.title)}</li>`).join('')}
    </ul>` : '<p style="margin:16px 0 0;">Their wishlist is still empty - a gentle nudge through the anonymous notes might help! &#128140;</p>';
  return {
    // Subject and preheader never name the child: they pop up in notifications
    // and inbox lists where anyone nearby can read them.
    subject: `Ho ho ho! Your Secret Santa match in ${teamName} is in 🎅`,
    html: layout({
      profileLink,
      appTitle,
      emoji: '&#127877;',
      title: 'The names are drawn!',
      preheader: `The names are drawn in ${teamName} - open this when nobody is peeking.`,
      body: `
        <p style="margin:0 0 6px;">Dear ${esc(santaName)}, the elves have spoken &#129497;. In <b>${esc(teamName)}</b> you are the Secret Santa for&hellip;</p>
        ${tag('Your child is', childName, childLocation ? `playing from ${childLocation}` : '')}
        ${facts([['Game on', startDate ? `${fmtDate(startDate)} - ${fmtDate(endDate)}` : ''], ['Budget', budget]])}
        ${wishHtml}
        <p style="margin:16px 0 0;">Shh&hellip; &#129323; keep it under your Santa hat. You can log gifts, set fun tasks and send anonymous notes from the app.</p>`,
      cta: { label: 'See your child', url: link },
      footer: 'What happens at the North Pole stays at the North Pole.',
    }),
    text: textOf([`Dear ${santaName},`, '', `In ${teamName} you are the Secret Santa for: ${childName}${childLocation ? ` (${childLocation})` : ''}`,
      startDate ? `Game on: ${fmtDate(startDate)} - ${fmtDate(endDate)}` : null, budget ? `Budget: ${budget}` : null,
      wishes.length ? `\nTheir wishlist:\n${wishes.map((w) => `- ${w.title}${w.url ? ` ${w.url}` : ''}`).join('\n')}` : null,
      '', `Open the app: ${link}`, '', 'Keep it secret!']),
  };
}

function start({ profileLink, appTitle, name, teamName, endDate, childName, link }) {
  return {
    subject: `🎄 Let the games begin: ${teamName} starts today!`,
    html: layout({
      profileLink,
      appTitle,
      emoji: '&#127876;',
      title: 'Let the games begin!',
      preheader: `${teamName} starts today and runs until ${fmtDate(endDate)}.`,
      body: `
        <p style="margin:0 0 10px;">Jingle all the way, ${esc(name)}! <b>${esc(teamName)}</b> is officially ON. &#127881;</p>
        ${childName ? tag('Remember, you are Santa for', childName, `until ${fmtDate(endDate)}`) : ''}
        <p style="margin:0 0 6px;">&#127873; Leave little surprises (and log them in the app)<br>
        &#129497; Set your child a fun task - everyone can see the task board<br>
        &#128140; Ask questions anonymously through Santa notes</p>`,
      cta: { label: 'Open the game', url: link },
    }),
    text: textOf([`Jingle all the way, ${name}!`, `${teamName} starts today and runs until ${fmtDate(endDate)}.`,
      childName ? `You are Santa for: ${childName}` : null, '', `Open the game: ${link}`]),
  };
}

function taskAssigned({ profileLink, appTitle, childName, teamName, title, details, dueDate, link }) {
  return {
    subject: '🧝 Your Secret Santa has a mission for you!',
    html: layout({
      profileLink,
      appTitle,
      emoji: '&#129497;',
      title: 'A secret mission arrives!',
      preheader: `New fun task in ${teamName}: ${title}`,
      body: `
        <p style="margin:0 0 6px;">Psst, ${esc(childName)}! Your Secret Santa in <b>${esc(teamName)}</b> has set you a fun task:</p>
        ${tag('Your mission', title, dueDate ? `by ${fmtDate(dueDate)}` : '')}
        ${details ? quote(details) : ''}
        <p style="margin:6px 0 0;">The whole team can see the task board, so give it your best elf effort! &#11088; Mark it done when you've nailed it.</p>`,
      cta: { label: 'Accept the mission', url: link },
    }),
    text: textOf([`Psst, ${childName}! Your Secret Santa in ${teamName} has set you a fun task:`, '', title, details || null,
      dueDate ? `By: ${fmtDate(dueDate)}` : null, '', `Open the app: ${link}`]),
  };
}

function giftLogged({ profileLink, appTitle, childName, teamName, description, isFinal, link }) {
  return {
    subject: isFinal ? '🎁 The BIG one! Your final Secret Santa gift is here' : '🎁 Psst… your Secret Santa left you something!',
    html: layout({
      profileLink,
      appTitle,
      emoji: '&#127873;',
      title: isFinal ? 'The grand finale gift!' : 'A little surprise for you!',
      preheader: `${teamName}: ${description}`,
      body: `
        <p style="margin:0 0 6px;">Ding dong, ${esc(childName)}! Your Secret Santa in <b>${esc(teamName)}</b> says a ${isFinal ? '<b>final</b> ' : ''}gift is on its way:</p>
        ${tag(isFinal ? 'The final gift' : 'Gift', description)}
        <p style="margin:6px 0 0;">Got it? Mark it received in the app and leave a thank-you note - your Santa will see it (but you still won't know who they are &#128584;).</p>`,
      cta: { label: 'Say thank you', url: link },
    }),
    text: textOf([`Ding dong, ${childName}! Your Secret Santa in ${teamName} says a ${isFinal ? 'final ' : ''}gift is on its way:`, '', description, '', `Open the app: ${link}`]),
  };
}

function message({ profileLink, appTitle, toName, fromLabel, subjectFrom = fromLabel, teamName, body, link }) {
  return {
    subject: `💌 A note from ${subjectFrom}`,
    html: layout({
      profileLink,
      appTitle,
      emoji: '&#128140;',
      title: 'You have a Santa note!',
      preheader: `${subjectFrom} wrote to you in ${teamName}.`,
      body: `
        <p style="margin:0 0 6px;">Hi ${esc(toName)}, <b>${esc(fromLabel)}</b> sent you a note in <b>${esc(teamName)}</b>:</p>
        ${quote(body)}
        <p style="margin:6px 0 0;">Reply from the app - your identity stays wrapped up tight. &#127873;</p>`,
      cta: { label: 'Reply', url: link },
    }),
    text: textOf([`Hi ${toName}, ${fromLabel} sent you a note in ${teamName}:`, '', body, '', `Reply in the app: ${link}`]),
  };
}

function reveal({ profileLink, appTitle, name, teamName, santaName, link }) {
  return {
    subject: `🎉 The big reveal: who was your Secret Santa in ${teamName}?`,
    html: layout({
      profileLink,
      appTitle,
      emoji: '&#127881;',
      title: 'The big reveal!',
      preheader: `Your Secret Santa in ${teamName} was...`,
      body: `
        <p style="margin:0 0 6px;">Drumroll please, ${esc(name)}&hellip; &#129345; The game is over and the masks come off. Your Secret Santa in <b>${esc(teamName)}</b> was&hellip;</p>
        ${santaName ? tag('Your Secret Santa', santaName, 'Go on, give them a big festive thank-you!') : '<p>&hellip;open the app to find out!</p>'}`,
      cta: { label: 'See all the fun', url: link },
      footer: 'Thank you for playing - same time next year?',
    }),
    text: textOf([`Drumroll please, ${name}...`, `Your Secret Santa in ${teamName} was: ${santaName || '(open the app)'}`, '', link]),
  };
}

function reminder({ appTitle, name, teamName, startDate, link, profileLink }) {
  return {
    subject: `✨ ${teamName}: a little wishlist inspiration`,
    html: layout({
      appTitle,
      emoji: '&#10024;',
      title: 'Psst... your wishlist misses you',
      preheader: `${teamName} starts ${fmtDate(startDate)}.`,
      body: `
        <p style="margin:0 0 6px;">Hey ${esc(name)}! &#128075; <b>${esc(teamName)}</b> kicks off on <b>${esc(fmtDate(startDate))}</b>.</p>
        <p style="margin:0 0 6px;">If you have a spare minute, a few wishes (links welcome!) and a hint or two about what makes you smile will help your Secret Santa no end. No pressure at all - even a single idea is a lovely gift to them. &#127873;</p>`,
      cta: { label: 'Open my wishlist', url: link },
      profileLink,
    }),
    text: textOf([`Hey ${name}! ${teamName} kicks off on ${fmtDate(startDate)}.`, 'If you have a spare minute, a few wishes and hints help your Secret Santa. No pressure at all!', '', link]),
  };
}

// Phase 1: where are you playing from? Kind, and says opting out is fine.
function locationReminder({ appTitle, name, teamName, deadline, locationName, link, profileLink }) {
  return {
    subject: `🌍 Where will you be jingling from? (${teamName})`,
    html: layout({
      appTitle,
      emoji: '&#127757;',
      title: 'Quick check-in, elf!',
      preheader: `Tell us where you're playing from${deadline ? ` by ${fmtDate(deadline)}` : ''} - it takes one click.`,
      body: `
        <p style="margin:0 0 6px;">Hi ${esc(name)}! &#128075; <b>${esc(teamName)}</b> is getting ready, and we'd love to pair you with a Secret Santa buddy close by.</p>
        ${locationName ? tag('We have you down for', locationName, 'Still right? One click to confirm.') : '<p style="margin:0 0 6px;">We don\'t know where you\'re playing from yet - just pick your spot from the list.</p>'}
        <p style="margin:0 0 6px;">Whenever you have a moment${deadline ? ` before <b>${esc(fmtDate(deadline))}</b>` : ''}, pop in and let us know. &#128205;</p>
        <p style="margin:0;font-size:14px;color:#5b544a;">Not feeling festive this year? That's completely okay - there's a <b>Sit this one out</b> button too, no questions asked. &#128155;</p>`,
      cta: { label: 'Check in', url: link },
      footer: 'Shh... the elves are already warming up the sleigh.',
      profileLink,
    }),
    text: textOf([`Hi ${name}! ${teamName} is getting ready.`, locationName ? `We have you down for ${locationName} - still right?` : 'Where are you playing from?',
      `Whenever you have a moment${deadline ? ` before ${fmtDate(deadline)}` : ''}, let us know: ${link}`, '', 'Not feeling festive this year? You can sit this one out - no questions asked.']),
  };
}

// Phase 2: a friendly jingle before the game ends. Never "you haven't...".
function giftReminder({ appTitle, name, teamName, childName, endDate, daysLeft, giftsSoFar, link, profileLink }) {
  const when = daysLeft <= 0 ? 'today' : daysLeft === 1 ? 'tomorrow' : `in ${daysLeft} days`;
  return {
    subject: `🔔 A little jingle from ${teamName}`,
    html: layout({
      appTitle,
      emoji: '&#128276;',
      title: 'Just a friendly jingle',
      preheader: `${teamName} wraps up ${when} - no stress, just a heads-up.`,
      body: `
        <p style="margin:0 0 6px;">Hi ${esc(name)}! &#127876; <b>${esc(teamName)}</b> wraps up ${when} (${esc(fmtDate(endDate))}).</p>
        ${tag('Your child', childName)}
        ${giftsSoFar > 0
    ? '<p style="margin:0 0 6px;">Your little surprises have been a hit already. &#127881; If you are planning a final gift, the app is ready whenever you are.</p>'
    : `<p style="margin:0 0 6px;">Whenever you're ready, ${esc(childName)} would love a little something - big or small, homemade or shop-bought, it's truly the thought that counts.</p>`}
        <p style="margin:0;font-size:14px;color:#5b544a;">And if life has been busy, no stress at all - this is meant to be fun. &#128155;</p>`,
      cta: { label: 'Peek at their wishlist', url: link },
      profileLink,
    }),
    text: textOf([`Hi ${name}! ${teamName} wraps up ${when} (${fmtDate(endDate)}).`, `Your child: ${childName}.`,
      giftsSoFar > 0 ? 'Your surprises have been a hit already!' : `Whenever you're ready, ${childName} would love a little something.`,
      'No stress at all - this is meant to be fun.', '', link]),
  };
}

function testEmail({ appTitle, link }) {
  return {
    subject: `🔔 Jingle check: ${appTitle} can send email!`,
    html: layout({
      appTitle,
      emoji: '&#128276;',
      title: 'Jingle check passed!',
      preheader: 'Your mail relay settings work.',
      body: `
        <p style="margin:0 0 6px;">If you can read this, the elves wired the mail relay up correctly. &#9989;</p>
        <p style="margin:0;">Sign-in codes, match announcements and Santa notes will all go out this way.</p>`,
      cta: link ? { label: 'Back to the workshop', url: link } : null,
    }),
    text: textOf(['Jingle check passed! Your mail relay settings work.']),
  };
}

const TEMPLATES = { otp, matched, start, taskAssigned, giftLogged, message, reveal, reminder, locationReminder, giftReminder, test: testEmail };

// Sample data for the admin's "preview" page.
function sample(kind, { appTitle, link }) {
  const s = {
    otp: { name: 'Holly Berry', code: '482913' },
    matched: { santaName: 'Holly Berry', childName: 'Jack Frost', childLocation: 'North Pole', teamName: 'Workshop Elves', budget: '$25', startDate: '2026-12-01', endDate: '2026-12-24', wishlist: [{ title: 'Fuzzy reindeer socks', url: 'https://www.example.com/socks' }, { title: 'A good mystery novel' }] },
    start: { name: 'Holly Berry', teamName: 'Workshop Elves', endDate: '2026-12-24', childName: 'Jack Frost' },
    taskAssigned: { childName: 'Jack Frost', teamName: 'Workshop Elves', title: 'Wear a festive hat to the stand-up', details: 'Bonus points for jingle bells.', dueDate: '2026-12-12' },
    giftLogged: { childName: 'Jack Frost', teamName: 'Workshop Elves', description: 'A mug of hot cocoa on your desk', isFinal: false },
    message: { toName: 'Jack Frost', fromLabel: 'your Secret Santa', teamName: 'Workshop Elves', body: 'Quick question - tea or coffee person? ☕' },
    reveal: { name: 'Jack Frost', teamName: 'Workshop Elves', santaName: 'Holly Berry' },
    reminder: { name: 'Jack Frost', teamName: 'Workshop Elves', startDate: '2026-12-01', profileLink: `${link}/#/profile` },
    locationReminder: { name: 'Jack Frost', teamName: 'Workshop Elves', deadline: '2026-11-20', locationName: 'North Pole', profileLink: `${link}/#/profile` },
    giftReminder: { name: 'Holly Berry', teamName: 'Workshop Elves', childName: 'Jack Frost', endDate: '2026-12-24', daysLeft: 3, giftsSoFar: 0, profileLink: `${link}/#/profile` },
    test: {},
  }[kind];
  if (!s) return null;
  return TEMPLATES[kind]({ appTitle, link, ...s });
}

module.exports = { ...TEMPLATES, TEMPLATES, sample, layout, esc, fmtDate };
