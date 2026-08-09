import { many, query, one } from '../db/index.js';

/**
 * Cross-Account Protection.
 *
 * Google sends a security event when one of our users' Google accounts is
 * compromised, disabled, or has its grants revoked. Acting on those events is
 * the difference between holding a refresh token for an account that has been
 * taken over and dropping it within seconds.
 *
 * Events arrive as Security Event Tokens: signed JWTs, verified against
 * Google's published keys. An unverified token is discarded, because the
 * endpoint is public and anyone can post to it.
 */

const ISSUER = 'https://accounts.google.com/';
const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';

let jwks = { keys: [], fetchedAt: 0 };

async function keys() {
  // Google rotates these. An hour is well inside the rotation window and
  // avoids fetching on every event.
  if (jwks.keys.length && Date.now() - jwks.fetchedAt < 3600_000) return jwks.keys;
  const res = await fetch(JWKS_URL);
  if (!res.ok) throw new Error(`Could not fetch Google's keys: ${res.status}`);
  const json = await res.json();
  jwks = { keys: json.keys || [], fetchedAt: Date.now() };
  return jwks.keys;
}

const b64url = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

/**
 * Verify a Security Event Token and return its claims.
 *
 * Throws rather than returning null, so a caller cannot mistake a rejected
 * token for an empty one.
 */
export async function verifyToken(jwt, { audience }) {
  const { createPublicKey, createVerify } = await import('node:crypto');

  const parts = String(jwt || '').split('.');
  if (parts.length !== 3) throw new Error('Not a JWT');

  const header = JSON.parse(b64url(parts[0]).toString('utf8'));
  const claims = JSON.parse(b64url(parts[1]).toString('utf8'));

  const key = (await keys()).find((k) => k.kid === header.kid);
  if (!key) throw new Error(`Unknown signing key ${header.kid}`);
  if (header.alg !== 'RS256') throw new Error(`Unexpected algorithm ${header.alg}`);

  const ok = createVerify('RSA-SHA256')
    .update(`${parts[0]}.${parts[1]}`)
    .verify(createPublicKey({ key, format: 'jwk' }), b64url(parts[2]));
  if (!ok) throw new Error('Signature does not verify');

  if (claims.iss !== ISSUER) throw new Error(`Wrong issuer: ${claims.iss}`);

  // The audience is our own client id. Without this check, a token minted for
  // a different application would be accepted here.
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (audience && !aud.includes(audience)) throw new Error('Token is not addressed to us');

  // Tokens are short-lived; a replayed old one must not be acted upon.
  const now = Math.floor(Date.now() / 1000);
  if (claims.iat && claims.iat > now + 300) throw new Error('Token is from the future');
  if (claims.exp && claims.exp < now - 60) throw new Error('Token has expired');

  return claims;
}

/**
 * What each event means for a connection we hold.
 *
 * Anything that says the account is no longer safe, or no longer ours to
 * read, results in the stored refresh token being dropped. Losing a working
 * connection is a smaller harm than keeping a compromised one.
 */
const DROP_ON = new Set([
  'https://schemas.openid.net/secevent/risc/event-type/account-disabled',
  'https://schemas.openid.net/secevent/risc/event-type/account-purged',
  'https://schemas.openid.net/secevent/risc/event-type/account-credential-change-required',
  'https://schemas.openid.net/secevent/risc/event-type/sessions-revoked',
  'https://schemas.openid.net/secevent/risc/event-type/tokens-revoked',
  'https://schemas.openid.net/secevent/oauth/event-type/token-revoked'
]);

const NOTE_ONLY = new Set([
  'https://schemas.openid.net/secevent/risc/event-type/account-enabled',
  'https://schemas.openid.net/secevent/risc/event-type/verification'
]);

/**
 * Apply one verified event. Returns what was done, for the log.
 */
export async function applyEvent(claims) {
  const events = claims.events || {};
  const done = [];

  for (const [type, body] of Object.entries(events)) {
    const email = body?.subject?.email || claims.sub || null;

    if (NOTE_ONLY.has(type)) {
      done.push({ type, action: 'noted', email });
      continue;
    }

    if (!DROP_ON.has(type)) {
      done.push({ type, action: 'ignored, not an event we act on', email });
      continue;
    }

    if (!email) {
      done.push({ type, action: 'could not act: no subject email', email: null });
      continue;
    }

    // Drop every connection held for that Google account, across projects.
    const affected = await many(
      `UPDATE projects SET
         ga4_refresh_token = NULL, ga4_property_id = NULL, ga4_property_name = NULL,
         gsc_site_url = NULL, google_scopes = NULL, ga4_connected_at = NULL
       WHERE lower(ga4_account_email) = lower($1)
       RETURNING id, name`,
      [email]
    );

    done.push({ type, action: `disconnected ${affected.length} project(s)`, email, projects: affected });
  }

  return done;
}

/** Record every event, acted upon or not, so the endpoint is auditable. */
export async function logEvent({ verified, claims, actions, error, raw }) {
  await query(
    `INSERT INTO security_events (verified, jti, issued_at, event_types, actions, error, raw)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      Boolean(verified),
      claims?.jti || null,
      claims?.iat ? new Date(claims.iat * 1000) : null,
      Object.keys(claims?.events || {}),
      JSON.stringify(actions || []),
      error || null,
      String(raw || '').slice(0, 4000)
    ]
  );
}

export async function recentEvents(limit = 30) {
  return many(
    `SELECT id, verified, jti, issued_at, event_types, actions, error, created_at
     FROM security_events ORDER BY created_at DESC LIMIT $1`,
    [limit]
  );
}

export async function eventCounts() {
  return one(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE verified)::int AS verified,
            COUNT(*) FILTER (WHERE NOT verified)::int AS rejected,
            MAX(created_at) AS last_at
     FROM security_events`
  );
}
