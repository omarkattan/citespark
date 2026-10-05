export const QUALITY_METRICS=['sessions','engagedSessions','engagementRate','sessionKeyEventRate','userEngagementDuration'];
export function parseTrafficQuality(json,from,to){
 if(json.metadata?.subjectToThresholding||json.metadata?.dataLossFromOtherRow||json.metadata?.samplingMetadatas?.length)throw Error('Traffic quality has data limitations.');
 if(json.metricHeaders?.map(h=>h.name).join(',')!==QUALITY_METRICS.join(',')||(json.dimensionHeaders||[]).length)throw Error('Unexpected quality fields.');
 if((json.rows||[]).length!==1||Number(json.rowCount)!==1)throw Error('No complete quality aggregate.');
 const values=json.rows[0].metricValues;
 if(values?.length!==QUALITY_METRICS.length||values.some(v=>v.value==null||v.value===''||!Number.isFinite(Number(v.value))||Number(v.value)<0))throw Error('Invalid quality values.');
 const data=Object.fromEntries(QUALITY_METRICS.map((k,i)=>[k,Number(values[i].value)]));
 if(data.engagedSessions>data.sessions||data.engagementRate>1||data.sessionKeyEventRate>1)throw Error('Invalid quality denominators.');
 if(data.sessions>0&&Math.abs(data.engagementRate-data.engagedSessions/data.sessions)>0.0001)throw Error('Engagement rate does not reconcile.');
 return {state:'ready',from,to,...data};
}
export function qualityForPeriod(quality,from,to,sessions){
 if(quality?.state!=='ready')return {state:'unavailable'};
 if(quality.from!==from||quality.to!==to)return {state:'different_period'};
 return {...quality,detailSessions:sessions,sessionTotalsDiffer:quality.sessions!==sessions,engagementRate:quality.sessions?quality.engagementRate:null,sessionKeyEventRate:quality.sessions?quality.sessionKeyEventRate:null,engagementSecondsPerSession:quality.sessions?quality.userEngagementDuration/quality.sessions:null};
}
export function trafficQualityHtml(q,{compact=false}={}){
 if(q?.state!=='ready')return '<p class="note small">Visit-quality metrics are unavailable for this exact period. Sync Analytics to request the current 90-day aggregate. Missing quality data is not zero.</p>';
 const percent=v=>v==null?'Not measured':(v*100).toFixed(1)+'%';
 if(compact)return `${q.sessionTotalsDiffer?`<p class="note small"><b>Different GA4 totals:</b> ${q.sessions} aggregate sessions; ${q.detailSessions} in detailed rows. The reason is unconfirmed. Rates below use only the aggregate.</p>`:''}<h3>Visit quality</h3><table><thead><tr><th>Measure</th><th>Result</th></tr></thead><tbody><tr><td>Engaged sessions</td><td>${q.engagedSessions} / ${q.sessions} (${percent(q.engagementRate)})</td></tr><tr><td>Sessions with a key event</td><td>${percent(q.sessionKeyEventRate)} of ${q.sessions} sessions</td></tr></tbody></table><p class="note small">Same covered dates and AI referral filter. GA4 session rates are not unique-lead rates or proof of buying intent.</p>`;
 return `${q.sessionTotalsDiffer?`<p class="note small"><b>Two GA4 query totals:</b> the period aggregate returned ${q.sessions} sessions; the detailed date/source/landing-page rows sum to ${q.detailSessions}. Quality metrics use the period aggregate only. The reason for this difference has not been established. Do not force these totals to match or calculate a rate by mixing the two queries.</p>`:''}<h3>How engaged were AI-referred visits?</h3><table><thead><tr><th>Measure</th><th>Result</th><th>Denominator</th></tr></thead><tbody><tr><td>Engaged sessions</td><td>${q.engagedSessions} / ${q.sessions} (${percent(q.engagementRate)})</td><td>AI-referred sessions</td></tr><tr><td>Sessions triggering a key event</td><td>${percent(q.sessionKeyEventRate)}</td><td>${q.sessions} AI-referred sessions, counted by GA4 at session level</td></tr><tr><td>Engagement time per session</td><td>${q.engagementSecondsPerSession==null?'Not measured':q.engagementSecondsPerSession.toFixed(1)+' seconds'}</td><td>${q.sessions} AI-referred sessions</td></tr></tbody></table><p class="note small">Same covered dates and AI referral filter as the traffic totals. GA4 rates come from a single period aggregate; engagement time per session divides foreground seconds by that aggregate’s sessions, not averages of daily rates or key-event counts divided by sessions. Engagement follows the property’s GA4 definition and is not proof of buying intent. Key-event sessions may include recruitment or other non-sales activity. They are not unique people or qualified leads. Engagement time measures foreground activity, not elapsed visit duration.</p>`;
}
