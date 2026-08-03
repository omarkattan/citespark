import 'dotenv/config';
import { query } from '../db/index.js';

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

async function accessToken() {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
      grant_type: 'refresh_token'
    })
  });
  if (!res.ok) throw new Error(`Token refresh failed: ${res.status}`);
  const json = await res.json();
  return json.access_token;
}

async function runReport(propertyId, body) {
  const token = await accessToken();
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

export async function syncGa4(projectId, { propertyId, days = 540 } = {}) {
  const property = propertyId || process.env.GA4_PROPERTY_ID;
  if (!property || !process.env.GOOGLE_REFRESH_TOKEN) {
    return { skipped: true, reason: 'GA4 not configured' };
  }

  const dateRanges = [{ startDate: `${days}daysAgo`, endDate: 'yesterday' }];
  const metrics = [
    { name: 'sessions' },
    { name: 'conversions' },
    { name: 'totalRevenue' }
  ];

  const native = rowsOf(
    await runReport(property, {
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
    await runReport(property, {
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

  return { skipped: false, native: native.length, derived: derived.length, written };
}
