import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { createSign } from 'node:crypto';

/**
 * Register the Cross-Account Protection receiver with Google.
 *
 *   npm run risc:register -- /path/to/service-account.json
 *   npm run risc:register -- key.json --status     just show the current stream
 *   npm run risc:register -- key.json --verify     ask Google to send a test event
 *
 * There is no console button for this: the stream is configured through an
 * authenticated API call, so it needs a service account key from the same
 * project as the OAuth client.
 */
const args = process.argv.slice(2);
const keyPath = args.find((a) => !a.startsWith('--'));
const statusOnly = args.includes('--status');
const verifyOnly = args.includes('--verify');

if (!keyPath) {
  console.error('Usage: npm run risc:register -- /path/to/service-account.json [--status|--verify]');
  console.error('\nCreate the key in Cloud Console: IAM & Admin > Service Accounts > Create,');
  console.error('then Keys > Add key > JSON. It must be in the same project as your OAuth client.\n');
  process.exit(1);
}

const key = JSON.parse(readFileSync(keyPath, 'utf8'));
const RECEIVER = `https://${process.env.CANONICAL_HOST || 'cited.ae'}/api/security/risc`;
const SCOPE = 'https://www.googleapis.com/auth/risc.configuration';

/** A self-signed JWT, which is what Google accepts for this API. */
function selfSignedToken() {
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const header = b64({ alg: 'RS256', typ: 'JWT', kid: key.private_key_id });
  const claims = b64({
    iss: key.client_email,
    sub: key.client_email,
    aud: 'https://risc.googleapis.com/google.identity.risc.v1beta.RiscManagementService',
    iat: now,
    exp: now + 3600
  });
  const sig = createSign('RSA-SHA256').update(`${header}.${claims}`).sign(key.private_key).toString('base64url');
  return `${header}.${claims}.${sig}`;
}

async function call(path, { method = 'GET', body } = {}) {
  const res = await fetch(`https://risc.googleapis.com/v1beta/${path}`, {
    method,
    headers: { Authorization: `Bearer ${selfSignedToken()}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  if (!res.ok) throw new Error(json?.error?.message || `${res.status}: ${text.slice(0, 300)}`);
  return json || {};
}

console.log(`\nService account: ${key.client_email}`);
console.log(`Receiver       : ${RECEIVER}\n`);

if (statusOnly) {
  const stream = await call('stream');
  console.log(JSON.stringify(stream, null, 2));
  process.exit(0);
}

if (verifyOnly) {
  const state = `check-${Date.now()}`;
  await call('stream:verify', { method: 'POST', body: { state } });
  console.log(`Verification event sent with state "${state}".`);
  console.log('It should appear within a minute at: npm run log, or /api/security/risc/status\n');
  process.exit(0);
}

/**
 * Everything worth being told about. Each of these means a connected account
 * is no longer safe or no longer ours to read.
 */
const EVENTS = [
  'https://schemas.openid.net/secevent/risc/event-type/account-credential-change-required',
  'https://schemas.openid.net/secevent/risc/event-type/account-disabled',
  'https://schemas.openid.net/secevent/risc/event-type/account-enabled',
  'https://schemas.openid.net/secevent/risc/event-type/account-purged',
  'https://schemas.openid.net/secevent/risc/event-type/sessions-revoked',
  'https://schemas.openid.net/secevent/risc/event-type/tokens-revoked',
  'https://schemas.openid.net/secevent/risc/event-type/verification'
];

await call('stream:update', {
  method: 'POST',
  body: {
    delivery: { delivery_method: 'https://schemas.openid.net/secevent/risc/delivery-method/push', url: RECEIVER },
    events_requested: EVENTS
  }
});

console.log('Stream configured. Subscribed to:');
for (const e of EVENTS) console.log(`  ${e.split('/').pop()}`);

console.log('\nSending a verification event to confirm the receiver answers...');
const state = `setup-${Date.now()}`;
await call('stream:verify', { method: 'POST', body: { state } });
console.log(`Sent with state "${state}".`);
console.log('\nConfirm it arrived:  npm run log   (or /api/security/risc/status in the app)');
console.log('The project checkup clears once Google has seen the stream active.\n');
