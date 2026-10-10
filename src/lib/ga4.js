import {QUALITY_METRICS,parseTrafficQuality} from './traffic-quality.js';
import {trafficSourceLabel} from './traffic-sources.js';
import 'dotenv/config';
import { pool, query, one } from '../db/index.js';
import { encrypt, decrypt } from './tokens.js';

/** GA4 ingestion: one OR-filtered query includes the AI Assistant medium and
 * exact recognised source hosts. New data uses ai_referral_v2. Legacy native
 * and derived rows are retained but never combined with verified totals. */

export const AI_SOURCES = {
  'chatgpt.com': 'ChatGPT',
  'chat.openai.com': 'ChatGPT',
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
  'duckduckgo.com/aichat': 'DuckAssist'
};

export function classifySource(source) {
  if (!source) return null;
  const s = String(source).trim().toLowerCase().replace(/^www\./, '');
  // Match complete hosts only, never chatgpt.com.other-domain.example.
  for (const [domain, platform] of Object.entries(AI_SOURCES)) {
    if (!domain.includes('/') && s === domain.replace(/^www\./, '')) return platform;
  }
  return null;
}

/**
 * Scopes are requested for the thing being connected, not bundled.
 *
 * Google's unbundled consent policy requires incremental authorisation, and
 * the project checkup flags a client that asks for everything at once. It is
 * also the better ask: someone connecting Analytics should not be made to
 * hand over Search Console to do it.
 *
 * include_granted_scopes means a later grant adds to the first rather than
 * replacing it, so connecting both still results in one credential.
 */
export const SCOPE_SETS = {
  ga4: ['https://www.googleapis.com/auth/analytics.readonly'],
  gsc: ['https://www.googleapis.com/auth/webmasters.readonly'],
  // Kept for connections made before scopes were split.
  both: [
    'https://www.googleapis.com/auth/analytics.readonly',
    'https://www.googleapis.com/auth/webmasters.readonly'
  ]
};

const IDENTITY = ['openid', 'email'];

export const scopesFor = (what) => [...(SCOPE_SETS[what] || SCOPE_SETS.both), ...IDENTITY];

/** Retained for anything still importing the old name. */
export const OAUTH_SCOPES = scopesFor('both');
export const oauthConfigured = Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);

/** The consent screen URL. state carries the project and a signature. */
export function authUrl({ redirectUri, state, what = 'both' }) {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: scopesFor(what).join(' '),
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
    signal: AbortSignal.timeout(60000),
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

  // Record what was actually granted. Google silently returns fewer scopes
  // than requested when one is not registered on the consent screen, and
  // without this we cannot tell that apart from a disabled API.
  return { refreshToken: json.refresh_token, email, scopes: json.scope || '' };
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

/**
 * Save an authorisation against the service it was granted for.
 *
 * Every grant used to be written to one column, so connecting Search Console
 * replaced the Analytics credential and vice versa. In an agency these are
 * routinely owned by different people, which meant one of the two was always
 * broken.
 */
export async function storeConnection(projectId, { refreshToken, email, scopes }, what = 'ga4') {
  if (what === 'gsc') {
    await query(
      `UPDATE projects SET gsc_refresh_token = $2, gsc_account_email = $3, gsc_connected_at = now(),
                           gsc_site_url = NULL
       WHERE id = $1`,
      [projectId, encrypt(refreshToken), email || null]
    );
    return;
  }

  await query(
    `UPDATE projects SET ga4_refresh_token = $2, ga4_account_email = $3, ga4_connected_at = now(),
                         ga4_property_id = NULL, ga4_property_name = NULL, google_scopes = $4
     WHERE id = $1`,
    [projectId, encrypt(refreshToken), email, scopes || null]
  );
}

export const SEARCH_CONSOLE_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';

export function hasSearchConsoleScope(project) {
  // Older connections predate the scope and have nothing recorded, so we
  // cannot rule it out. Let the API call decide in that case.
  if (!project?.google_scopes) return null;
  return project.google_scopes.includes('webmasters');
}

/**
 * Disconnect Google from a site.
 *
 * One credential covers both Analytics and Search Console, so clearing the
 * token while leaving the Search Console property behind left a site pointing
 * at a property it could no longer read, and nothing to click to fix it.
 *
 * `what` narrows it where only one side should go: choosing a different
 * Search Console property should not cost someone their Analytics link.
 */
export async function disconnect(projectId, what = 'all') {
  if (what === 'gsc') {
    // Its own credential now, so disconnecting Search Console leaves
    // Analytics untouched even when they are different accounts.
    await query(
      `UPDATE projects SET gsc_site_url = NULL, gsc_refresh_token = NULL,
                           gsc_account_email = NULL, gsc_connected_at = NULL
       WHERE id = $1`,
      [projectId]
    );
    return;
  }

  if (what === 'ga4') {
    await query(
      `UPDATE projects SET ga4_property_id = NULL, ga4_property_name = NULL, ga4_synced_at = NULL
       WHERE id = $1`,
      [projectId]
    );
    return;
  }

  await query(
    `UPDATE projects SET ga4_refresh_token = NULL, ga4_property_id = NULL, ga4_property_name = NULL,
                         ga4_account_email = NULL, ga4_connected_at = NULL, ga4_synced_at = NULL,
                         gsc_site_url = NULL, google_scopes = NULL,
                         gsc_refresh_token = NULL, gsc_account_email = NULL, gsc_connected_at = NULL
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
  /**
   * Google says why in the body. Reporting only the status turned three
   * different problems into one number, and a 403 here is usually an API
   * nobody has switched on rather than a permissions failure.
   */
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const reason = (() => {
      try {
        return JSON.parse(body)?.error?.message || '';
      } catch {
        return '';
      }
    })();

    if (res.status === 403 && /has not been used|is disabled|SERVICE_DISABLED/i.test(reason)) {
      throw new Error(
        'The Google Analytics Admin API is not enabled on our Google Cloud project. That is ours to fix, not yours.'
      );
    }
    if (res.status === 403) {
      throw new Error(
        reason
          ? `Google refused: ${reason}`
          : 'Google refused the request. The connected account may have no access to any Analytics property.'
      );
    }
    if (res.status === 401) {
      throw new Error('The Google connection has expired. Reconnecting takes one screen.');
    }
    throw new Error(reason || `Could not list properties (${res.status})`);
  }

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
      signal: AbortSignal.timeout(60000),
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

/**
 * Is Analytics usable for this site, and if not, precisely why not?
 *
 * The rule has three sources - the project's own token, then the deployment
 * env - and every caller must apply the same one. The report applied a
 * narrower rule than the sync did, so a site whose data was syncing happily
 * through the env credential was told on its own report that Analytics was
 * not connected. A warning that contradicts the data beside it costs more
 * trust than a missing section ever would.
 *
 * Returns why: null when usable, so callers can print the reason instead of
 * inventing one.
 */
export function ga4Readiness(project) {
  const token = Boolean(project?.ga4_refresh_token) || Boolean(process.env.GOOGLE_REFRESH_TOKEN);
  const property = Boolean(project?.ga4_property_id) || Boolean(process.env.GA4_PROPERTY_ID);
  if (token && property) return { connected: true, why: null };
  if (token && !property) {
    return { connected: false, why: 'Google is connected but no Analytics property has been chosen for this site.' };
  }
  if (!token && property) {
    return { connected: false, why: 'An Analytics property is set for this site but Google is not connected. Reconnect it in Setup.' };
  }
  return {
    connected: false,
    why: 'Google Analytics is not connected for this site, so we cannot show what the assistants sent. Connecting it is read-only and takes one screen.'
  };
}

export function aggregateTrafficRows(rows) {
 const map=new Map();
 for(const r of rows){const platform=trafficSourceLabel(classifySource(r.sessionSource)||r.sessionSource);const page=r.landingPage||'(not set)';const key=JSON.stringify([r.date,platform,page]);
 const v=map.get(key)||{date:isoDate(r.date),platform,page,sessions:0,keyEvents:0,revenue:0};
 v.sessions+=Number(r.sessions||0);v.keyEvents+=Number(r.keyEvents||0);v.revenue+=Number(r.totalRevenue||0);map.set(key,v);}
 return [...map.values()];
}
export function validateTrafficResponse(json) {
 if(Number(json.rowCount||0)>(json.rows||[]).length)throw new Error('Analytics returned an incomplete result. No stored traffic was replaced. Use a shorter sync window.');
 if(json.metadata?.subjectToThresholding||json.metadata?.dataLossFromOtherRow||json.metadata?.samplingMetadatas?.length)throw new Error('Analytics flagged thresholding, aggregation loss or sampling. No stored traffic was replaced.');
 if(!['date','sessionSource','landingPage'].every(n=>json.dimensionHeaders?.some(h=>h.name===n)) || !['sessions','keyEvents','totalRevenue'].every(n=>json.metricHeaders?.some(h=>h.name===n)))throw new Error('Analytics response is missing expected fields. No stored traffic was replaced.');
 for(const row of json.rows||[])if(row.dimensionValues?.length!==3 || row.metricValues?.length!==3 || row.metricValues.some(v=>v.value==null||v.value===''||!Number.isFinite(Number(v.value))))throw new Error('Analytics returned an invalid row. No stored traffic was replaced.');
}
export function validateEventResponse(json, {landingPages=false}={}) {
 if(Number(json.rowCount||0)>(json.rows||[]).length || json.metadata?.subjectToThresholding || json.metadata?.dataLossFromOtherRow || json.metadata?.samplingMetadatas?.length)throw new Error('Event breakdown incomplete or limited.');
 if(json.dimensionHeaders?.map(h=>h.name).join(',')!==(landingPages?'date,eventName,landingPage':'date,eventName') || json.metricHeaders?.map(h=>h.name).join(',')!=='keyEvents')throw new Error('Event breakdown fields missing.');
 for(const r of json.rows||[])if(r.dimensionValues?.length!==(landingPages?3:2) || !/^\d{8}$/.test(r.dimensionValues[0].value||'') || !r.dimensionValues[1].value || r.metricValues?.length!==1 || r.metricValues[0].value==null || r.metricValues[0].value==='' || !Number.isFinite(Number(r.metricValues[0].value)) || Number(r.metricValues[0].value)<0)throw new Error('Invalid event breakdown row.');
}
export async function syncGa4(projectId, { days = 540 } = {}) {
 const project=await one('SELECT * FROM projects WHERE id=$1',[projectId]);
 // A deployment-wide property must never supply another project’s traffic.
 const property=project?.ga4_property_id;
 if(!property)return {skipped:true,reason:'Choose an Analytics property for this project first.'};
 const ready=ga4Readiness(project);if(!ready.connected)return {skipped:true,reason:ready.why};
 const started=new Date(),end=new Date(started);end.setUTCDate(end.getUTCDate()-1);
 const start=new Date(end);start.setUTCDate(start.getUTCDate()-(Math.max(1,Math.min(540,Math.floor(Number(days)||540)))-1));
 const from=start.toISOString().slice(0,10),to=end.toISOString().slice(0,10);
 const hosts=[...new Set(Object.keys(AI_SOURCES).filter(x=>!x.includes('/')).flatMap(x=>[x.replace(/^www\./,''),'www.'+x.replace(/^www\./,'')]))];
 const request={
  dateRanges:[{startDate:from,endDate:to}],dimensions:[{name:'date'},{name:'sessionSource'},{name:'landingPage'}],
  metrics:[{name:'sessions'},{name:'keyEvents'},{name:'totalRevenue'}],
  dimensionFilter:{orGroup:{expressions:[{filter:{fieldName:'sessionMedium',stringFilter:{matchType:'EXACT',value:'ai-assistant',caseSensitive:false}}},{filter:{fieldName:'sessionSource',inListFilter:{values:hosts,caseSensitive:false}}}]}},limit:100000
 };
 const json=await runReport(project,property,request);
 validateTrafficResponse(json);
 const rows=aggregateTrafficRows(rowsOf(json));
 const info={version:2,propertyId:String(property),from,to,currency:/^[A-Z]{3}$/.test(json.metadata?.currencyCode||'')?json.metadata.currencyCode:null,startedAt:started.toISOString(),method:'ai_referral_v2'};
 // Event counts have their own query. Never sum sessions grouped by event name.
 try {
  const eventJson=await runReport(project,property,{...request,dimensions:[{name:'date'},{name:'eventName'}],metrics:[{name:'keyEvents'}]});
  validateEventResponse(eventJson);
  info.eventBreakdown={state:'ready',rows:rowsOf(eventJson).filter(r=>Number(r.keyEvents)>0).map(r=>({date:isoDate(r.date),name:r.eventName,count:Number(r.keyEvents)}))};
 } catch(error) {
  console.warn('GA4 event breakdown unavailable:',error.message);
  info.eventBreakdown={state:'unavailable'};
 }
 // Separate optional context query: a failed detail request must not hide valid totals.
 try {
  const context=await runReport(project,property,{...request,dimensions:[{name:'date'},{name:'eventName'},{name:'landingPage'}],metrics:[{name:'keyEvents'}]});
  validateEventResponse(context,{landingPages:true});
  info.eventContext={state:'ready',rows:rowsOf(context).filter(r=>Number(r.keyEvents)>0).map(r=>({date:isoDate(r.date),name:r.eventName,page:r.landingPage||'(not set)',count:Number(r.keyEvents)}))};
 }catch(error){console.warn('GA4 event context unavailable:',error.message);info.eventContext={state:'unavailable'};}
 // Optional session-quality aggregate for the report's exact rolling 90-day period.
 // Keep rates at period scope. They cannot be summed across dates or pages.
 try{
  const qualityStart=new Date(end);qualityStart.setUTCDate(qualityStart.getUTCDate()-89);
  const qualityFrom=qualityStart.toISOString().slice(0,10);
  const quality=await runReport(project,property,{dateRanges:[{startDate:qualityFrom,endDate:to}],metrics:QUALITY_METRICS.map(name=>({name})),dimensionFilter:request.dimensionFilter,limit:1});
  info.quality=parseTrafficQuality(quality,qualityFrom,to);
 }catch(error){console.warn('GA4 quality unavailable:',error.message);info.quality={state:'unavailable'};}
 const client=await pool.connect();
 try {await client.query('BEGIN');const current=(await client.query('SELECT ga4_property_id,ga4_synced_at FROM projects WHERE id=$1 FOR UPDATE',[projectId])).rows[0];
 if(String(current?.ga4_property_id)!==String(property))throw new Error('Analytics property changed during sync. Retry for the selected property.');
 if(current.ga4_synced_at&&new Date(current.ga4_synced_at)>started)throw new Error('A newer Analytics sync already completed. Its data was kept.');
 await client.query("DELETE FROM ga4_daily WHERE project_id=$1 AND classification_method='ai_referral_v2'",[projectId]);
 for(const r of rows)await client.query("INSERT INTO ga4_daily (project_id,date,platform,classification_method,landing_page,sessions,conversions,revenue) VALUES($1,$2,$3,'ai_referral_v2',$4,$5,$6,$7)",[projectId,r.date,r.platform,r.page,r.sessions,r.keyEvents,r.revenue]);
 await client.query('UPDATE projects SET ga4_synced_at=now(),ga4_sync_info=$2::jsonb WHERE id=$1',[projectId,JSON.stringify(info)]);
 await client.query('COMMIT');
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
 return {skipped:false,written:rows.length,from,to};
}
