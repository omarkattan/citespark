import { createHash } from 'node:crypto';

// Shared by the review endpoint and the worker. A confirmation describes the
// saved panel, not a possibly stale overview response from the browser.
export function configuredRunScope(project, prompts) {
  const engines = [...new Set(project.engines?.length ? project.engines : ['chatgpt'])];
  const runs = Number(project.runs_per_cycle || 1);
  const panel = prompts.map(p => ({id: p.id, text: p.text, language: p.language || p.origin_details?.language || (/[\u0620-\u064A]/u.test(p.text || '') ? 'ar' : 'en')}))
    .sort((a,b) => a.id - b.id);
  const languages = {};
  for (const p of panel) languages[p.language] = (languages[p.language] || 0) + 1;
  const snapshot = {projectId: project.id, engines, runs, market: project.market,
    location: project.location_name || null, models: project.models || {}, panel};
  return {engines, runs, market: project.market, languages, questions: panel.length,
    checks: panel.length * engines.length * runs,
    fingerprint: createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')};
}

export function runScopeProblem(scope, budget, confirmed) {
  if (confirmed && confirmed !== scope.fingerprint)
    return 'The saved questions or measurement settings changed. Review the current scope and cost again. No answer checks have started.';
  if (!budget.ok) return budget.reason;
  if (budget.runs !== scope.runs || JSON.stringify(budget.engines) !== JSON.stringify(scope.engines))
    return 'Your saved engines or repeat count exceed your current access. Adjust measurement settings or upgrade, then review again. No answer checks have started.';
  if (budget.maxCalls < scope.checks)
    return 'The available allowance or spend limit cannot cover this complete measurement. Reduce the scope or increase your allowance, then review again. No answer checks have started.';
  return null;
}

/** A manual run may sample each saved engine once, or one saved engine once. */
export function projectForSample(project, sample) {
  if (sample == null) return project;
  const engines = project.engines?.length ? project.engines : ['chatgpt'];
  if (sample !== 'each-once' && !engines.includes(sample)) return null;
  return {...project, engines: sample === 'each-once' ? engines : [sample], runs_per_cycle: 1};
}
