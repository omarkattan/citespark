import { collectionDisplayText } from './collection-display.js';
import { evidenceUrl } from './report-actions.js';
import { questionRole } from './search-evidence.js';

const esc = value => collectionDisplayText(value).replace(/[&<>"']/g, c =>
  ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]));

export function answerCountLink(e, filter, label, questionId) {
  if (!Array.isArray(e.answers)) return esc(label);
  const target = 'answers-' + filter + (questionId == null ? '' : '-q' + questionId);
  return '<a href="#' + esc(target) + '">' + esc(label) + '</a>';
}

export function answerIndexHtml(report) {
  const e = report.executive;
  if (!Array.isArray(e.answers)) return '';
  const batch = e.measurement;
  const settings = batch?.settings || {};
  const peers = new Map((settings.entities || []).filter(x => x.kind === 'competitor').map(x => [String(x.id), x.name]));
  const questions = new Map(e.questions.map(q => [String(q.id), q.text]));
  const rows = e.answers.map(a => {
    const question = questions.get(String(a.questionId)) || '';
    const names = a.peerIds.map(id => peers.get(String(id))).filter(Boolean);
    const priority = !e.provisional && !e.localeWarnings?.length && !a.possiblyTruncated && a.cited && !a.named && names.length > 0 && questionRole(question) === 'Buyer decision';
    return {a, question, names, priority};
  }).sort((x,y) => Number(y.priority) - Number(x.priority));
  const items = rows.map(({a, question, names, priority}) => {
    const ref = 'Answer #' + a.id;
    const link = batch?.id && report.project.id && a.id
      ? '<a href="/api/projects/' + encodeURIComponent(report.project.id) + '/measurements/' + encodeURIComponent(batch.id) + '#run-' + encodeURIComponent(a.id) + '">' + esc(ref) + '</a>' : esc(ref);
    const urls = a.urls.map(evidenceUrl).filter(Boolean).map(url => '<a href="'+esc(url)+'">'+esc(url)+'</a>');
    return '<tr data-question="'+esc(a.questionId)+'" data-named="'+Number(a.named)+'" data-cited="'+Number(a.cited)+'"><td dir="auto">'+esc(question)+'<small>'+link+' · '+esc(a.engine)+' · '+esc(a.collected || 'Date unavailable')+'</small></td><td>'+ (a.named?'Named':'Unnamed')+' · '+(a.cited?'Cited':'No observed citation')+(priority?'<small>Buyer question with a tracked competitor named</small>':'')+'</td><td>'+esc(names.join(', ') || 'None confirmed')+'</td><td>'+urls.join('<br>')+'</td></tr>';
  });
  const controls = [['all','All measured answers'],['named','Named'],['cited','Cited'],['cited-unnamed','Cited but unnamed']];
  const printed = new Map();
  for (const {a} of rows) {
    if (!a.id || (!a.named && !a.cited)) continue;
    const group = printed.get(a.questionId) || [];
    group.push('#' + a.id + ' (' + [a.named && 'named', a.cited && 'cited'].filter(Boolean).join(', ') + ')');
    printed.set(a.questionId, group);
  }
  const printRefs = [...printed].map(([id, refs]) => '<p dir="auto"><b>' + esc(questions.get(String(id))) + '</b> · ' + esc(refs.join(' · ')) + '</p>').join('');
  const filters = ['all','named','cited','cited-unnamed'];
  const targets = [...filters.map(f=>'answers-'+f), ...e.questions.flatMap(q=>['named','cited'].map(f=>'answers-'+f+'-q'+q.id))];
  return '<style>.printed-answer-refs{display:none}@media print{.printed-answer-refs{display:block}#answer-evidence-list,#answer-evidence nav{display:none}}</style><section id="answer-evidence">'+targets.map(id=>'<span id="'+esc(id)+'"></span>').join('')+'<h2>Answer evidence</h2><p>Measurement '+esc(batch?.id || 'unknown')+' · '+esc(settings.locationName || settings.market || 'Market unavailable')+'. Open an answer reference for its full text and collection settings.</p><nav aria-label="Filter stored answers">'+controls.map(([key,label])=>answerCountLink(e,key,label)).join(' · ')+'</nav><details id="answer-evidence-list"><summary>View stored answer references</summary><p role="status" id="answer-evidence-count"></p><table><thead><tr><th>Question and stored answer</th><th>Outcome</th><th>Tracked competitors named</th><th>Owned sources</th></tr></thead><tbody>'+items.join('')+'</tbody></table></details><div class="printed-answer-refs"><h3>Stored answer references</h3>'+printRefs+'</div></section>';
}

export const answerIndexScript = `
function showEvidenceFilter() {
  const match = /^#answers-(all|named|cited-unnamed|cited)(?:-q([0-9]+))?$/.exec(location.hash);
  const list = document.getElementById('answer-evidence-list');
  if (!list || !match) return;
  const [, filter, question] = match;
  let count = 0;
  for (const row of list.querySelectorAll('tbody tr')) {
    const {named,cited} = row.dataset;
    const matches = filter === 'all' || (filter === 'named' && named === '1') ||
      (filter === 'cited' && cited === '1') || (filter === 'cited-unnamed' && cited === '1' && named === '0');
    row.hidden = !(matches && (!question || question === row.dataset.question));
    if (!row.hidden) count++;
  }
  document.getElementById('answer-evidence-count').textContent = count + ' matching measured answers · ' + filter.replaceAll('-', ' ') + (question ? ' · question #' + question : '');
  list.open = true;
  list.scrollIntoView();
}
window.addEventListener('hashchange',showEvidenceFilter);
document.addEventListener('click',event=>{
  const href=event.target.closest?.('a')?.getAttribute('href');
  if(href && href===location.hash && href.startsWith('#answers-')) showEvidenceFilter();
});
showEvidenceFilter();
`;
