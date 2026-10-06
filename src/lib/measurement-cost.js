// Budget estimates, not provider price quotes. Exact model-family matching
// prevents a mini-model price from being used for its larger sibling.
export function estimateEngineCosts(engines, configs, overrides={}, history=[], modelHistory=[]) {
 const costs=new Map();
 for(const engine of engines){
  const wanted=overrides[engine]||configs[engine]?.model;
  const matches=m=>m===wanted || (m.startsWith(wanted+'-') && /^\d{4}-\d{2}-\d{2}$/.test(m.slice(wanted.length+1)));
  const rows=wanted?modelHistory.filter(r=>r.engine===engine&&matches(r.model||'')):history.filter(r=>r.engine===engine);
  const known=rows.map(r=>Number(r.per)).filter(n=>Number.isFinite(n)&&n>0);
  // Use the highest matching observed average. Without matching history,
  // GPT-4.1 gets a $0.10 planning allowance based on our small paid pilot.
  const fallback=engine==='chatgpt'&&/^gpt-4\.1(?:-\d{4}-\d{2}-\d{2})?$/.test(wanted||'')?0.10:0.03;
  costs.set(engine,known.length?Math.max(...known):fallback);
 }
 return costs;
}
