import 'dotenv/config';

/**
 * Tell someone when something happens.
 *
 * Everything here is fire and forget. A notification failing must never break
 * the thing that triggered it: a Slack outage should not stop a signup.
 *
 * Configure either or both:
 *   SLACK_WEBHOOK_URL   an incoming webhook
 *   RESEND_API_KEY      plus NOTIFY_EMAIL and NOTIFY_FROM
 */

const SLACK = process.env.SLACK_WEBHOOK_URL;
const RESEND = process.env.RESEND_API_KEY;
const TO = process.env.NOTIFY_EMAIL;
const FROM = process.env.NOTIFY_FROM || 'Cited <notifications@cited.ae>';
const SITE = process.env.CANONICAL_HOST ? `https://${process.env.CANONICAL_HOST}` : '';

export const notificationsConfigured = Boolean(SLACK || (RESEND && TO));

const ICON = {
  trial: ':mag:',
  signup: ':wave:',
  paid: ':moneybag:',
  feedback: ':speech_balloon:',
  digest: ':bar_chart:',
  problem: ':warning:'
};

async function toSlack({ kind, title, lines, url }) {
  if (!SLACK) return;

  const blocks = [
    { type: 'section', text: { type: 'mrkdwn', text: `${ICON[kind] || ':bell:'} *${title}*` } }
  ];
  if (lines?.length) {
    blocks.push({ type: 'section', fields: lines.slice(0, 10).map((l) => ({ type: 'mrkdwn', text: l })) });
  }
  if (url) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `<${url}|Open>` }]
    });
  }

  await fetch(SLACK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: `${title}${lines?.length ? '\n' + lines.join('\n') : ''}`, blocks })
  });
}

async function toEmail({ kind, title, lines, url, html }) {
  if (!RESEND || !TO) return;

  const body =
    html ||
    `<div style="font-family:-apple-system,system-ui,sans-serif;font-size:15px;line-height:1.6;color:#14161a">
       <h2 style="font-size:18px;margin:0 0 12px">${escapeHtml(title)}</h2>
       ${lines?.length ? `<ul style="padding-left:18px;margin:0 0 16px">${lines.map((l) => `<li>${escapeHtml(stripMd(l))}</li>`).join('')}</ul>` : ''}
       ${url ? `<p><a href="${url}" style="color:#157a4a">${escapeHtml(url)}</a></p>` : ''}
       <p style="color:#75887c;font-size:12px;margin-top:24px">Cited &middot; ${new Date().toLocaleString()}</p>
     </div>`;

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM, to: [TO], subject: `${ICON[kind] ? '' : ''}${title}`, html: body })
  });
}

const stripMd = (s) => String(s).replace(/[*_`<>|]/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/**
 * Send a notification. Never throws, never blocks the caller.
 */
export function notify(payload) {
  if (!notificationsConfigured) return;

  // Deliberately not awaited by callers: a slow webhook must not slow a
  // request, and a failing one must not fail it.
  Promise.allSettled([toSlack(payload), toEmail(payload)]).then((results) => {
    for (const r of results) {
      if (r.status === 'rejected') console.warn('notification failed:', String(r.reason?.message || r.reason));
    }
  });
}

/* ---------------- the events worth interrupting someone for ---------------- */

export function notifyTrial({ domain, brandName, rate, runs, source, question }) {
  const pct = rate === null || rate === undefined ? null : Math.round(rate * 100);
  const hot = pct === 0;

  notify({
    kind: 'trial',
    title: hot
      ? `${domain} scored 0% visibility`
      : `${domain} tried the demo${pct !== null ? ` and scored ${pct}%` : ''}`,
    lines: [
      brandName ? `*Brand*\n${brandName}` : null,
      pct !== null ? `*Visibility*\n${pct}% of ${runs} answers` : null,
      source ? `*Came from*\n${source}` : null,
      question ? `*Question*\n${question}` : null,
      hot ? `*Why it matters*\nInvisible for their own category question. Easiest conversation you will have today.` : null
    ].filter(Boolean),
    url: SITE ? `${SITE}/uae` : null
  });
}

export function notifySignup({ email, org }) {
  notify({
    kind: 'signup',
    title: `New account: ${email}`,
    lines: [org ? `*Organisation*\n${org}` : null].filter(Boolean),
    url: SITE ? `${SITE}/app` : null
  });
}

export function notifyPaid({ email, plan, interval, amount }) {
  notify({
    kind: 'paid',
    title: `${plan} subscription started`,
    lines: [
      email ? `*Customer*\n${email}` : null,
      `*Plan*\n${plan}${interval ? `, billed ${interval}ly` : ''}`,
      amount ? `*Amount*\n$${amount}` : null
    ].filter(Boolean)
  });
}

export function notifyFeedback({ kind, message, email, view }) {
  notify({
    kind: 'feedback',
    title: `Feedback: ${kind}`,
    lines: [
      `*What they said*\n${String(message).slice(0, 500)}`,
      email ? `*From*\n${email}` : '*From*\nanonymous',
      view ? `*On screen*\n${view}` : null
    ].filter(Boolean)
  });
}
