import 'dotenv/config';
import { query, one } from '../db/index.js';
import { encrypt, decrypt } from './tokens.js';

/**
 * GA4 ingestion.
 *
 * Two series are pulled deliberately:
 *
 *  1. 'native'  - sessionMedium = 'ai-assistant'. Google's own AI Assistant
 *                 channel, added May 2026. Accurate, but NOT retroactive:
 *                 sessions processed before the rollout still sit in Referral.
 *
 *  2. 'derived' - sessionSource matched against our own domain list. This
 *                 works on historical data, so a new customer gets a real
 *                 trend line on day one instead of starting from June 2026.
 *                 It also catches sources Google has not yet recognised.
 *
 * Report both. The difference between them is a selling point, not an error.
 */

export const AI_SOURCES = {
  'chatgpt.com': 'ChatGPT',
  'chat.openai.com': 'ChatGPT',
  'openai.com': 'ChatGPT',
  'perplexity.ai': 'Perplexity',
  'www.perplexity.ai': 'Perplexity',
  'gemini.google.com': 'Gemini',
  'bard.google.com': 'Gemini',
  'claude.ai': 'Claude',
  'copilot.microsoft.com': 'Copilot',
  'bing.com/chat': 'Copilot',
  'you.com': 'You.com',
  'poe.com': 'Poe',
  'grok.com': 'Grok',
  'x.ai': 'Grok',
  'duckduckgo.com/aichat': 'DuckAssist'
};

export function classifySource(source) {
  if (!source) return null;
  const s = source.toLowerCase().replace(/^www\./, '');
  for (const [domain, platform] of Object.entries(AI_SOURCES)) {
    if (s === domain.replace(/^www\./, '') || s.startsWith(domain)) return platform;
  }
  return null;
}

export const OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/analytics.readonly',
  // Search Console rides on the same authorisation, so a customer approves
  // once rather than twice. Existing connections predate this and will need
  // reconnecting before the import screen works.
  'https://www.googleapis.com/auth/webmasters.readonly',
  'openid',
  'email'
];
export const oauthConfigured = Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);

/** The consent screen URL. state carries the project and a signature. */
export function authUrl({ redirectUri, state }) {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: OAUTH_SCOPES.join(' '),
    access_type: 'offline',
    // select_account matters as much as consent: without it Google silently
    // reuses whichever account the browser is already signed into, so an
    // agency connecting a second client never gets the chance to pick a
    // different one. consent forces a refresh token on repeat authorisations.
    prompt: 'select_account consent',
    include_granted_scopes: 'true',
    state
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

async function tokenRequest(body) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body)
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error_description || json.error || `Token request failed: ${res.status}`);
  return json;
}

export async function exchangeCode({ code, redirectUri }) {
  const json = await tokenRequest({
    code,
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code'
  });
  if (!json.refresh_token) {
    throw new Error('Google did not return a refresh token. Remove Cited from your Google account permissions and try again.');
  }

  let email = null;
  try {
    const me = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${json.access_token}` }
    });
    if (me.ok) email = (await me.json()).email || null;
  } catch {
    // Not essential, only used to show which account is connected.
  }
  return { refreshToken: json.refresh_token, email };
}

/**
 * Access tokens for a project's own stored refresh token, falling back to the
 * deployment-wide env vars so an existing single-tenant setup keeps working.
 */
async function accessTokenFor(project) {
  const stored = project?.ga4_refresh_token ? decrypt(project.ga4_refresh_token) : null;
  const refresh = stored || process.env.GOOGLE_REFRESH_TOKEN;
  if (!refresh) throw new Error('Google Analytics is not connected for this site');

  const json = await tokenRequest({
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    refresh_token: refresh,
    grant_type: 'refresh_token'
  });
  return json.access_token;
}

/** Save an authorisation against a project. */
export async function storeConnection(projectId, { refreshToken, email }) {
  await query(
    `UPDATE projects SET ga4_refresh_token = $2, ga4_account_email = $3, ga4_connected_at = now(),
                         ga4_property_id = NULL, ga4_property_name = NULL
     WHERE id = $1`,
    [projectId, encrypt(refreshToken), email]
  );
}

export async function disconnect(projectId) {
  await query(
    `UPDATE projects SET ga4_refresh_token = NULL, ga4_property_id = NULL, ga4_property_name = NULL,
                         ga4_account_email = NULL, ga4_connected_at = NULL, ga4_synced_at = NULL
     WHERE id = $1`,
    [projectId]
  );
}

/** Every GA4 property the connected account can read. */
export async function listProperties(project) {
  const token = await accessTokenFor(project);
  const res = await fetch('https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageSize=200', {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok) throw new Error(`Could not list properties: ${res.status}`);
  const json = await res.json();

  const out = [];
  for (const account of json.accountSummaries || []) {
    for (const p of account.propertySummaries || []) {
      out.push({
        id: String(p.property || '').replace('properties/', ''),
        name: p.displayName,
        account: account.displayName
      });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

async function runReport(project, propertyId, body) {
  const token = await accessTokenFor(project);
  const res = await fetch(
    `https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }
  );
  if (!res.ok) throw new Error(`GA4 runReport failed: ${res.status} ${await res.text()}`);
  return res.json();
}

function rowsOf(json) {
  const dims = (json.dimensionHeaders || []).map((h) => h.name);
  const mets = (json.metricHeaders || []).map((h) => h.name);
  return (json.rows || []).map((row) => {
    const out = {};
    dims.forEach((d, i) => (out[d] = row.dimensionValues[i].value));
    mets.forEach((m, i) => (out[m] = Number(row.metricValues[i].value)));
    return out;
  });
}

function isoDate(compact) {
  return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
}

export async function syncGa4(projectId, { days = 540 } = {}) {
  const project = await one('SELECT * FROM projects WHERE id = $1', [projectId]);
  const property = project?.ga4_property_id || process.env.GA4_PROPERTY_ID;
  const hasToken = project?.ga4_refresh_token || process.env.GOOGLE_REFRESH_TOKEN;

  if (!property || !hasToken) {
    return { skipped: true, reason: 'Google Analytics is not connected for this site' };
  }

  const dateRanges = [{ startDate: `${days}daysAgo`, endDate: 'yesterday' }];
  const metrics = [
    { name: 'sessions' },
    { name: 'conversions' },
    { name: 'totalRevenue' }
  ];

  const native = rowsOf(
    await runReport(project, property, {
      dateRanges,
      dimensions: [{ name: 'date' }, { name: 'sessionSource' }, { name: 'landingPage' }],
      metrics,
      dimensionFilter: {
        filter: { fieldName: 'sessionMedium', stringFilter: { matchType: 'EXACT', value: 'ai-assistant' } }
      },
      limit: 100000
    })
  );

  const all = rowsOf(
    await runReport(project, property, {
      dateRanges,
      dimensions: [{ name: 'date' }, { name: 'sessionSource' }, { name: 'landingPage' }],
      metrics,
      limit: 100000
    })
  );

  const derived = all.filter((r) => classifySource(r.sessionSource));

  let written = 0;
  const write = async (rows, method) => {
    for (const r of rows) {
      const platform = classifySource(r.sessionSource) || r.sessionSource;
      await query(
        `INSERT INTO ga4_daily (project_id, date, platform, classification_method, landing_page, sessions, conversions, revenue)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (project_id, date, platform, classification_method, landing_page)
         DO UPDATE SET sessions = EXCLUDED.sessions, conversions = EXCLUDED.conversions, revenue = EXCLUDED.revenue`,
        [projectId, isoDate(r.date), platform, method, r.landingPage, r.sessions, r.conversions, r.totalRevenue]
      );
      written++;
    }
  };

  await write(native, 'native');
  await write(derived, 'derived');
  await query('UPDATE projects SET ga4_synced_at = now() WHERE id = $1', [projectId]);

  return { skipped: false, native: native.length, derived: derived.length, written };
}
