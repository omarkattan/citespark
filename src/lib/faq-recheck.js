import {many,one} from '../db/index.js';
import {measurementSettings} from './measurement-batches.js';
import {resolveModel,ENGINES,ENGINE_IDS} from './dataforseo.js';
import {budgetForCycle} from './billing.js';
import {introductionOnly} from './answer-eligibility.js';

export function sampleSummary(rows,domain) {
  const own=String(domain).replace(/^www\./,'').toLowerCase();
  return [...new Set(rows.map(r=>r.engine))].sort().map(engine=>{
    const all=rows.filter(r=>r.engine===engine),usable=all.filter(r=>r.ok&&r.response_text?.trim()&&!r.no_overview&&!introductionOnly(r.response_text)&&r.named!==null);
    return {engine,attempted:all.length,usable:usable.length,named:usable.filter(r=>r.named).length,cited:usable.filter(r=>(r.domains||[]).some(d=>String(d).replace(/^www\./,'').toLowerCase()===own)).length};
  });
}
export function comparableSamples(before,after,settingsSame) {
  return Boolean(settingsSame&&before.length&&before.length===after.length&&before.every(b=>{
    const a=after.find(x=>x.engine===b.engine);return a&&b.usable===b.attempted&&a.usable===a.attempted&&a.usable===b.usable;
  }));
}
async function samples(projectId,promptId,measurementId,newOnly=false){return many(`SELECT r.id,r.engine,r.model,r.ok,r.response_text,r.no_overview,
 (SELECT BOOL_OR(m.mentioned) FROM mentions m JOIN entities e ON e.id=m.entity_id WHERE m.run_id=r.id AND e.project_id=$1 AND e.kind='owned') AS named,
 ARRAY(SELECT c.domain FROM citations c WHERE c.run_id=r.id) AS domains
 FROM measurement_answers a JOIN runs r ON r.id=a.run_id
 WHERE a.measurement_id=$3 AND r.project_id=$1 AND r.prompt_id=$2 AND (NOT $4 OR r.measurement_id=$3)`,[projectId,promptId,measurementId,newOnly]);}
export async function matchedRecheckScope(project,draft,newId=null,{settings}={}) {
  const baseline=await one("SELECT * FROM measurement_batches WHERE id=$1 AND project_id=$2 AND status='completed'",[draft.baseline_measurement_id,project.id]);
  if(!baseline||baseline.legacy||!baseline.settings?.detection)return {eligible:false,reason:'The original measurement settings are unknown. Run a complete measurement to create a new baseline.'};
  const prompt=await one('SELECT text,active FROM prompts WHERE id=$1 AND project_id=$2',[draft.prompt_id,project.id]);
  if(!prompt?.active||prompt.text!==draft.question)return {eligible:false,reason:'The question changed or is paused. Restore the original wording and active status, or create a new baseline.'};
  const beforeRows=await samples(project.id,draft.prompt_id,baseline.id),before=sampleSummary(beforeRows,project.domain);
  const baselineModelsMatch=beforeRows.every(r=>!baseline.settings.models?.[r.engine]||r.model===baseline.settings.models[r.engine]);
  if(!before.length||!baselineModelsMatch||before.some(b=>b.attempted!==b.usable||b.usable!==baseline.settings.runs)||before.length!==baseline.settings.engines?.length)return {eligible:false,reason:'This baseline has missing, mixed-model or extra retry samples. Run all active questions once to create a complete baseline.'};
  if(newId){
    const fresh=await one('SELECT * FROM measurement_batches WHERE id=$1 AND project_id=$2',[newId,project.id]);
    const same=await one('SELECT settings=$2::jsonb AS same FROM measurement_batches WHERE id=$1',[newId,JSON.stringify(baseline.settings)]);
    const afterRows=await samples(project.id,draft.prompt_id,newId,true),after=sampleSummary(afterRows,project.domain);
    const modelsMatch=afterRows.every(r=>!baseline.settings.models?.[r.engine]||r.model===baseline.settings.models[r.engine]);
    return {eligible:true,comparable:fresh?.status==='completed'&&modelsMatch&&comparableSamples(before,after,same?.same),before,after,baseline_id:baseline.id,measurement_id:newId};
  }
  if(!settings){
    const engines=(project.engines?.length?project.engines:(process.env.ENGINES||'chatgpt').split(',')).map(x=>x.trim()).filter(x=>ENGINE_IDS.includes(x)),models={};
    for(const engine of engines)if(ENGINES[engine]?.kind==='llm')models[engine]=await resolveModel(engine,ENGINES[engine],project.models?.[engine]||null);
    const entities=await many('SELECT id,name,aliases,domain,kind,ambiguous_name FROM entities WHERE project_id=$1',[project.id]);
    settings=measurementSettings(project,models,engines,project.runs_per_cycle,Number(process.env.MAX_OUTPUT_TOKENS||2000),entities);
  }
  const match=await one('SELECT settings=$2::jsonb AS same FROM measurement_batches WHERE id=$1',[baseline.id,JSON.stringify(settings)]);
  const latest=await one("SELECT settings=$2::jsonb AND NOT legacy AS same FROM measurement_batches WHERE project_id=$1 AND status='completed' AND purpose='monitoring' ORDER BY cycle_date DESC,completed_at DESC,id DESC LIMIT 1",[project.id,JSON.stringify(settings)]);
  if(!match?.same||!latest?.same)return {eligible:false,reason:'Engines, models, market, competitors or collection settings changed. Restore the baseline settings, or run all questions for a new baseline.'};
  const calls=before.reduce((sum,b)=>sum+b.usable,0),counts=Object.fromEntries(before.map(b=>[b.engine,b.usable]));
  const budget=await budgetForCycle(project.org_id,{questions:1,engines:settings.engines,runs:settings.runs});
  if(!budget.ok||budget.maxCalls<calls)return {eligible:false,reason:budget.reason||'There are not enough answer checks for a matched repeat. No checks have been started.'};
  return {eligible:true,question:draft.question,baseline_id:baseline.id,before,counts,calls,estimated_usd:budget.estimateUsd,settings};
}
