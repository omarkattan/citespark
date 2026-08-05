import 'dotenv/config';
import { query } from '../db/index.js';

/**
 * Tell someone when something happens, and keep a record either way.
 *
 * Two separate jobs, deliberately:
 *
 *   The log is the record. Every event is written to the notifications table
 *   whether or not the email succeeds, so nothing is lost to a provider
 *   outage and `npm run log` always shows the full picture.
 *
 *   The email is only how you hear about it sooner. It is fire and forget: a
 *   failed send must never break the signup or trial that triggered it.
 */

const RESEND = process.env.RESEND_API_KEY;
const TO = process.env.NOTIFY_EMAIL;
const FROM = process.env.NOTIFY_FROM || 'Cited <notifications@cited.ae>';
const SITE = process.env.CANONICAL_HOST ? `https://${process.env.CANONICAL_HOST}` : 'https://cited.ae';

export const emailConfigured = Boolean(RESEND && TO);

const escapeHtml = (s) =>
  String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );

/** Plain, readable, and legible on a phone at seven in the morning. */
function render({ title, lead, rows, action, actionUrl }) {
  return `<div style="font-family:ui-sans-serif,-apple-system,system-ui,sans-serif;max-width:520px;margin:0 auto;padding:28px 24px;color:#14161a">
    <p style="font-family:ui-monospace,Menlo,monospace;font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:#75887c;margin:0 0 14px">Cited</p>
    <h1 style="font-size:21px;line-height:1.3;font-weight:600;margin:0 0 ${lead ? '10' : '18'}px">${escapeHtml(title)}</h1>
    ${lead ? `<p style="font-size:15px;line-height:1.6;color:#3d4a42;margin:0 0 18px">${escapeHtml(lead)}</p>` : ''}
    ${
      rows?.length
        ? `<table style="width:100%;border-collapse:collapse;margin:0 0 22px">${rows
            .map(
              ([k, v]) => `<tr>
                <td style="padding:7px 12px 7px 0;font-family:ui-monospace,Menlo,monospace;font-size:10px;letter-spacing:.09em;text-transform:uppercase;color:#75887c;vertical-align:top;white-space:nowrap">${escapeHtml(k)}</td>
                <td style="padding:7px 0;font-size:14.5px;color:#14161a;line-height:1.5">${escapeHtml(v)}</td>
              </tr>`
            )
            .join('')}</table>`
        : ''
    }
    ${
      action
        ? `<a href="${escapeHtml(actionUrl)}" style="display:inline-block;background:#157a4a;color:#fff;text-decoration:none;font-size:13px;padding:11px 18px;border-radius:3px">${escapeHtml(action)}</a>`
        : ''
    }
    <p style="color:#9aa8a0;font-size:11.5px;margin:26px 0 0;border-top:1px solid #e6eae7;padding-top:14px">
      ${new Date().toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })} &middot; Another Sandstorm Digital Production
    </p>
  </div>`;
}

async function send(payload) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM, to: [TO], subject: payload.subject || payload.title, html: render(payload) })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Resend ${res.status}: ${body.slice(0, 200)}`);
  }
}

/**
 * Log it, then try to email it. Never throws, never blocks the caller.
 */
export function notify({ kind, title, subject, lead, rows = [], action, actionUrl }) {
  const detail = { lead: lead || null, rows, action: action || null, actionUrl: actionUrl || null };

  (async () => {
    let emailed = false;
    let error = null;

    if (emailConfigured) {
      try {
        await send({ title, subject, lead, rows, action, actionUrl });
        emailed = true;
      } catch (err) {
        error = String(err.message || err);
        console.warn(`notification email failed: ${error}`);
      }
    }

    try {
      await query(
        'INSERT INTO notifications (kind, title, detail, emailed, email_error) VALUES ($1,$2,$3,$4,$5)',
        [kind, title, JSON.stringify(detail), emailed, error]
      );
    } catch (err) {
      // The log is the last resort, so if even that fails, say so loudly.
      console.error('could not write notification log:', String(err.message || err));
    }
  })();
}

/* ---------------- the events worth knowing about ---------------- */

export function notifyTrial({ domain, brandName, rate, runs, source, question }) {
  const pct = rate === null || rate === undefined ? null : Math.round(rate * 100);
  const invisible = pct === 0;

  notify({
    kind: 'trial',
    title: invisible ? `${domain} is invisible` : `${domain} tried the demo`,
    subject: invisible ? `Lead: ${domain} scored 0% AI visibility` : `${domain} tried Cited${pct !== null ? ` (${pct}%)` : ''}`,
    lead: invisible
      ? 'They typed their own domain in, waited, and found out AI never names them. This is the easiest conversation you will have today.'
      : null,
    rows: [
      brandName ? ['Brand', brandName] : null,
      pct !== null ? ['Visibility', `${pct}% of ${runs} answers`] : null,
      ['Came from', source || 'unknown'],
      question ? ['Question asked', question] : null
    ].filter(Boolean),
    action: 'Open the index',
    actionUrl: `${SITE}/uae`
  });
}

export function notifySignup({ email, org }) {
  notify({
    kind: 'signup',
    title: 'New account',
    subject: `New Cited account: ${email}`,
    rows: [['Email', email], org ? ['Organisation', org] : null].filter(Boolean)
  });
}

export function notifyPaid({ email, plan, interval, amount }) {
  notify({
    kind: 'paid',
    title: `${plan} subscription started`,
    subject: `Payment: ${plan}${amount ? `, $${amount}` : ''}`,
    rows: [
      email ? ['Customer', email] : null,
      ['Plan', `${plan}${interval ? `, billed ${interval}ly` : ''}`],
      amount ? ['Amount', `$${amount}`] : null
    ].filter(Boolean)
  });
}

export function notifyFeedback({ kind, message, email, view }) {
  notify({
    kind: 'feedback',
    title: `Feedback: ${kind}`,
    subject: `Cited feedback (${kind})`,
    lead: String(message).slice(0, 600),
    rows: [['From', email || 'anonymous'], view ? ['On screen', view] : null].filter(Boolean)
  });
}
