import crypto from 'node:crypto';
import 'dotenv/config';

/**
 * A Google refresh token is a long-lived key to someone else's analytics.
 * Storing it in plaintext means a database dump is a breach, so it is
 * encrypted at rest with AES-256-GCM.
 *
 * Set TOKEN_KEY to a long random string. It falls back to SESSION_SECRET so
 * nothing breaks without it, but rotating SESSION_SECRET would then orphan
 * every stored token, so a separate key is worth setting.
 */
const KEY = crypto
  .createHash('sha256')
  .update(process.env.TOKEN_KEY || process.env.SESSION_SECRET || 'insecure-development-key')
  .digest();

export function encrypt(plain) {
  if (plain === null || plain === undefined || plain === '') return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${enc.toString('base64url')}`;
}

export function decrypt(payload) {
  if (!payload) return null;
  const [version, ivB64, tagB64, dataB64] = String(payload).split('.');
  if (version !== 'v1' || !ivB64 || !tagB64 || !dataB64) return null;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(ivB64, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    // Wrong key, or tampered data. Treat as not connected rather than crashing.
    return null;
  }
}

/** Signed, expiring state for the OAuth round trip, to stop CSRF. */
export function signState(payload) {
  const body = Buffer.from(JSON.stringify({ ...payload, t: Date.now() })).toString('base64url');
  const sig = crypto.createHmac('sha256', KEY).update(body).digest('base64url').slice(0, 32);
  return `${body}.${sig}`;
}

export function readState(state, maxAgeMs = 10 * 60 * 1000) {
  const [body, sig] = String(state || '').split('.');
  if (!body || !sig) return null;
  const expected = crypto.createHmac('sha256', KEY).update(body).digest('base64url').slice(0, 32);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (Date.now() - payload.t > maxAgeMs) return null;
    return payload;
  } catch {
    return null;
  }
}
