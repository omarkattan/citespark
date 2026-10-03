import {one,many} from '../db/index.js';
import {buildReport} from './report.js';
import {currentAnalysis} from './report-analyst-store.js';
import {reportHtml} from './report-html.js';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const snapshotIdValid=id=>typeof id==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
export function snapshotDocument(report,ceo=false){
 const {id,savedAt,analysisState}=report.snapshot;
 const base=`/api/projects/${report.project.id}/report/snapshots/${id}`;
 const inclusion=analysisState==='included'?'Reviewed AI analysis included.':analysisState==='stale'?'AI analysis excluded because it did not match the evidence when this version was saved.':'No reviewed AI analysis included.';
 const banner=`<style>@media print{.snapshot-banner{font-size:9px!important;padding:6px!important;margin:0 0 8px!important;background:white!important}.snapshot-detail{display:none}}</style><aside class="snapshot-banner" style="max-width:1100px;margin:16px auto;padding:16px;border:1px solid #cad8d4;background:#edf2ef;font:14px/1.5 system-ui;color:#12333b"><b>Saved report version · ${esc(savedAt)}</b><br>${inclusion}<div class="snapshot-detail"> This saved copy does not update. Saving is not approval of its findings.<br>Full report and executive brief links open this same version. Source-page, measurement and task links open live evidence and may change.<p><a href="${base}${ceo?'':'?view=ceo'}">${ceo?'Open saved full report':'Open saved executive brief'}</a> · <a href="/api/projects/${report.project.id}/report/prepare">Back to live report preparation</a></p></div></aside>`;
 let html=reportHtml(report,{ceo});
 // Freeze the rendered report, including navigation to its paired document.
 html=html.replace(new RegExp(`href="(/api/projects/${report.project.id}/report(?:\\?[^"#]*)?(?:#[^"]*)?)"`,'g'),(original,target)=>{
  const url=new URL(target.replace(/&amp;/g,'&'),'https://cited.invalid');
  if(url.searchParams.get('detail')==='1')return original;
  return `href="${base}${url.searchParams.get('view')==='ceo'?'?view=ceo':''}${url.hash}"`;
 });
 html=html.replace(/<script>\s*const refreshButton=[\s\S]*?<\/script>/,'');
 return html.replace('<body>','<body>'+banner).replace(/<script src="\/context-help\.js[^\"]*" defer><\/script>/g,'');
}
export async function saveReportSnapshot(project,id,userId,range){
 if(!snapshotIdValid(id))throw Error('Refresh preparation before saving a report version.');
 const existing=await one('SELECT id,project_id FROM report_snapshots WHERE id=$1 AND project_id=$2',[id,project.id]);
 if(existing)return existing;
 const report=await buildReport(project.id,range,{presentationOnly:true});
 // Verification errors stop saving. Never silently turn an error into "no analysis".
 const analysis=await currentAnalysis(report);
 const state=analysis?.stale?'stale':analysis?'included':'none';
 if(state==='included')report.analyst={id:analysis.id,packet:analysis.packet,analysis:analysis.analysis,edit_revision:analysis.edit_revision,approved_at:analysis.approved_at};
 if(state==='stale')report.analystNotice='AI analysis was excluded from this saved version because its evidence did not match.';
 report.snapshot={id,savedAt:new Date().toISOString(),analysisState:state};
 const full=snapshotDocument(report),ceo=snapshotDocument(report,true);
 await one(`INSERT INTO report_snapshots(id,project_id,created_by,analysis_state,report,full_html,ceo_html)
 VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO NOTHING RETURNING id`,[id,project.id,userId,state,report,full,ceo]);
 const saved=await one('SELECT id,project_id FROM report_snapshots WHERE id=$1 AND project_id=$2',[id,project.id]);
 if(!saved)throw Error('This save identifier is unavailable. Refresh and try again.');
 return saved;
}
export async function listReportSnapshots(projectId){
 return many("SELECT id,created_at,analysis_state,report->'period' AS period FROM report_snapshots WHERE project_id=$1 ORDER BY created_at DESC,id LIMIT 20",[projectId]);
}
