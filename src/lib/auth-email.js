import { createHash, randomBytes } from 'node:crypto';
import { one, query, many } from '../db/index.js';
import { notifyTo } from './notify.js';

/**
 * Email verification and password reset.
 *
 * Tokens are stored hashed. A leaked database should not hand someone a set
 * of working password reset links, which is exactly what storing them in
 * plain text would do.
 */

const hash = (t) => createHash('sha256').update(t).digest('hex');

const LIFETIME = {
  verify: 48 * 3600 * 1000,
  reset: 60 * 60 * 1000 // an hour: long enough to find the email, short enough to matter
};

export async function issueToken(userId, kind) {
  const token = randomBytes(32).toString('base64url');

  // One live token per purpose. An old link left working after a new one is
  // requested is a second door nobody is watching.
  await query('UPDATE auth_tokens SET used_at = now() WHERE user_id = $1 AND kind = $2 AND used_at IS NULL', [
    userId,
    kind
  ]);

  await query(
    'INSERT INTO auth_tokens (user_id, kind, token_hash, expires_at) VALUES ($1,$2,$3,now() + ($4 || \' milliseconds\')::interval)',
    [userId, kind, hash(token), String(LIFETIME[kind])]
  );

  return token;
}

export async function consumeToken(token, kind) {
  if (!token) return null;

  const row = await one(
    `SELECT t.id, t.user_id, u.email FROM auth_tokens t JOIN users u ON u.id = t.user_id
     WHERE t.token_hash = $1 AND t.kind = $2 AND t.used_at IS NULL AND t.expires_at > now()`,
    [hash(token), kind]
  );
  if (!row) return null;

  // Marked used before the caller acts on it, so a link cannot be replayed by
  // double-clicking or by a mail client prefetching it.
  await query('UPDATE auth_tokens SET used_at = now() WHERE id = $1', [row.id]);
  return row;
}

export function sendVerification(email, link) {
  notifyTo(email, {
    kind: 'verify',
    title: 'Confirm your email',
    subject: 'Confirm your email for Cited',
    lead: 'One click and your account is ready. The link works for two days.',
    rows: [['Account', email]],
    action: 'Confirm this address',
    actionUrl: link
  });
}

export function sendReset(email, link) {
  notifyTo(email, {
    kind: 'reset',
    title: 'Set a new password',
    subject: 'Reset your Cited password',
    lead: 'Use the link below to set a new password. It works for one hour, and only once. If you did not ask for this, nothing has changed and you can ignore it.',
    rows: [['Account', email]],
    action: 'Set a new password',
    actionUrl: link
  });
}

/**
 * How many accounts this address has created recently.
 *
 * Every free account carries an answer-check allowance that costs real money
 * at the provider, so unlimited signups from one source is an open tab.
 */
export async function recentSignups(ip, { hours = 24 } = {}) {
  const row = await one(
    `SELECT COUNT(*)::int AS n FROM signup_attempts WHERE ip = $1 AND at > now() - ($2 || ' hours')::interval`,
    [ip, String(hours)]
  );
  return row?.n || 0;
}

export const recordSignup = (ip, email) =>
  query('INSERT INTO signup_attempts (ip, email) VALUES ($1,$2)', [ip, email]).catch(() => {});
