/**
 * The report as a printable document.
 *
 * HTML rather than a generated PDF: it prints to PDF from any browser, opens
 * on a phone, and can be pasted into an email. A PDF library would add a
 * dependency and take away all three.
 */

const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const pct = (n) => `${Math.round((n || 0) * 100)}%`;
const date = (d) => (d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '');

export function reportHtml(r) {
  const recurring = r.persistence.items.filter((i) => i.standing === 'recurring');
  const persistentSources = r.sources.sources.filter((s) => s.persistent).slice(0, 12);
  const changeWord = r.trend.change === null ? null : r.trend.change > 0.02 ? 'up' : r.trend.change < -0.02 ? 'down' : 'flat';

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<title>${esc(r.project.name)}: AI visibility report</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  @page { size: A4; margin: 18mm 16mm; }
  * { box-sizing: border-box; }
  body { font: 15px/1.6 -apple-system, system-ui, "Segoe UI", sans-serif; color: #14161a; max-width: 820px; margin: 0 auto; padding: 40px 24px 80px; }
  h1 { font-size: 30px; line-height: 1.2; margin: 0 0 6px; }
  h2 { font-size: 21px; margin: 44px 0 6px; padding-top: 22px; border-top: 1px solid #e3e7e4; }
  h2:first-of-type { border-top: none; padding-top: 0; }
  h3 { font-size: 15px; margin: 22px 0 6px; }
  p { margin: 0 0 12px; }
  .sub { color: #5d7268; font-size: 14px; margin-bottom: 30px; }
  .lede { font-size: 16.5px; color: #3d4a42; }
  table { width: 100%; border-collapse: collapse; margin: 14px 0 6px; font-size: 14px; }
  th { text-align: left; font-size: 11px; letter-spacing: .07em; text-transform: uppercase; color: #75887c; font-weight: 500; padding: 0 10px 7px 0; border-bottom: 1px solid #e3e7e4; }
  td { padding: 9px 10px 9px 0; border-bottom: 1px solid #eef1ef; vertical-align: top; }
  td.num, th.num { text-align: right; white-space: nowrap; }
  .tag { display: inline-block; font-size: 10.5px; letter-spacing: .06em; text-transform: uppercase; border: 1px solid #cfd8d2; border-radius: 3px; padding: 1px 6px; color: #5d7268; }
  .tag.hot { border-color: #b3261e; color: #b3261e; }
  .note { font-size: 13.5px; color: #5d7268; }
  .caveats { margin-top: 46px; padding: 18px 20px; background: #f5f7f6; border-left: 3px solid #cfd8d2; font-size: 13.5px; color: #3d4a42; }
  .caveats li { margin-bottom: 8px; }
  .bar { display: inline-block; height: 9px; background: #157a4a; border-radius: 2px; vertical-align: middle; }
  .foot { margin-top: 50px; padding-top: 16px; border-top: 1px solid #e3e7e4; font-size: 12px; color: #75887c; }
  a { color: #157a4a; word-break: break-word; }
  @media print { body { padding: 0; } h2 { page-break-after: avoid; } table { page-break-inside: avoid; } }
</style></head>
<body>

<h1>${esc(r.project.name)}</h1>
<p class="sub">AI visibility report &middot; ${esc(r.project.domain)} &middot; ${date(r.generatedAt)}</p>

<h2>Where things stand</h2>
${
  r.trend.cycles
    ? `<p class="lede">
        Across ${r.trend.cycles} measurement ${r.trend.cycles === 1 ? 'cycle' : 'cycles'}, ${esc(r.project.brand)} was named in
        <b>${pct(r.trend.last)}</b> of answers in the most recent one${
          changeWord && r.trend.cycles > 1
            ? `, ${changeWord === 'flat' ? 'about level with' : `${changeWord} from`} ${pct(r.trend.first)} at the start`
            : ''
        }.
      </p>
      <table><thead><tr><th>Cycle</th><th class="num">Questions</th><th class="num">Named in</th><th></th></tr></thead><tbody>
      ${r.trend.points
        .map(
          (p) => `<tr>
            <td>${date(p.cycle_date)}</td>
            <td class="num">${p.questions}</td>
            <td class="num">${pct(p.rate)}</td>
            <td><span class="bar" style="width:${Math.round((p.rate || 0) * 160)}px"></span></td>
          </tr>`
        )
        .join('')}
      </tbody></table>`
    : '<p>No cycles have completed yet.</p>'
}

<h2>What keeps coming back</h2>
<p class="note">
  Actions that recur cycle after cycle are structural: the thing causing them has not changed. Those are listed first,
  because fixing one of them removes a problem permanently rather than for a week.
</p>
${
  recurring.length
    ? `<table><thead><tr><th>Action</th><th class="num">Seen in</th><th class="num">Since</th></tr></thead><tbody>
      ${recurring
        .slice(0, 15)
        .map(
          (i) => `<tr>
            <td><b>${esc(i.title)}</b>${i.target_url ? `<br /><a href="${esc(i.target_url)}">${esc(i.target_url.slice(0, 78))}</a>` : ''}</td>
            <td class="num">${i.cycles} of ${r.persistence.totalCycles}</td>
            <td class="num">${date(i.first_seen)}</td>
          </tr>`
        )
        .join('')}
      </tbody></table>`
    : `<p>Nothing has recurred yet. ${r.persistence.totalCycles < 3 ? 'Three cycles are needed before a pattern can be called one.' : ''}</p>`
}

<h2>Who gets cited, and whether you ever do</h2>
<p class="note">
  The sources answers are built from in your category. Your own domain was cited in
  <b>${r.sources.ownCited} of ${r.sources.totalCycles}</b> cycles.
</p>
${
  persistentSources.length
    ? `<table><thead><tr><th>Source</th><th class="num">Cycles</th><th class="num">Questions</th><th class="num">Citations</th></tr></thead><tbody>
      ${persistentSources
        .map(
          (s) => `<tr>
            <td>${esc(s.domain)} ${s.cycles === r.sources.totalCycles ? '<span class="tag hot">every cycle</span>' : ''}
              ${s.example_url ? `<br /><a href="${esc(s.example_url)}">${esc(s.example_url.slice(0, 78))}</a>` : ''}</td>
            <td class="num">${s.cycles}</td>
            <td class="num">${s.questions}</td>
            <td class="num">${s.citations}</td>
          </tr>`
        )
        .join('')}
      </tbody></table>
      <p class="note">
        A source appearing in every cycle is not a passing mention. It is part of how this category gets answered, and
        being absent from it is a standing disadvantage.
      </p>`
    : '<p>Not enough cycles yet to say which sources persist.</p>'
}

<h2>What the pages being cited have in common</h2>
${
  r.patterns.pages
    ? `<p class="note">
        Measured across ${r.patterns.pages} pages that were actually cited in answers to your questions.
        ${r.patterns.medianWords ? `Median length ${r.patterns.medianWords.toLocaleString()} words.` : ''}
      </p>
      <table><thead><tr><th>Feature</th><th class="num">Share of cited pages</th><th></th></tr></thead><tbody>
      ${r.patterns.features
        .map(
          ([label, p]) => `<tr>
            <td>${esc(label)}</td>
            <td class="num">${p}%</td>
            <td><span class="bar" style="width:${Math.round(p * 1.6)}px"></span></td>
          </tr>`
        )
        .join('')}
      </tbody></table>
      ${
        r.patterns.schemaTypes.length
          ? `<p class="note">Most common structured data on cited pages: ${r.patterns.schemaTypes.map(([t, n]) => `${esc(t)} (${n})`).join(', ')}.</p>`
          : ''
      }`
    : `<p>${esc(r.patterns.note)}</p>`
}

<h2>Everything open, by how long it has been true</h2>
<table><thead><tr><th>Action</th><th class="num">Standing</th><th class="num">Seen in</th></tr></thead><tbody>
${r.persistence.items
  .slice(0, 40)
  .map(
    (i) => `<tr>
      <td>${esc(i.title)}</td>
      <td class="num"><span class="tag${i.standing === 'recurring' ? ' hot' : ''}">${i.standing}</span></td>
      <td class="num">${i.cycles} of ${r.persistence.totalCycles}</td>
    </tr>`
  )
  .join('')}
</tbody></table>

${
  r.completed.length
    ? `<h2>What has been done</h2>
      <table><thead><tr><th>Action</th><th class="num">Completed</th></tr></thead><tbody>
      ${r.completed.map((c) => `<tr><td>${esc(c.title)}</td><td class="num">${date(c.completed_at)}</td></tr>`).join('')}
      </tbody></table>`
    : ''
}

<div class="caveats">
  <b>How to read this</b>
  <ul>${r.caveats.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>
</div>

<p class="foot">
  Generated by Cited&trade; on ${date(r.generatedAt)} from ${r.trend.cycles} measurement ${r.trend.cycles === 1 ? 'cycle' : 'cycles'}.
  Another Sandstorm Digital&reg; Production.
</p>
</body></html>`;
}

/** The same actions as a spreadsheet, for anyone who wants to sort them. */
export function reportCsv(r) {
  const rows = [['title', 'type', 'standing', 'cycles_seen', 'total_cycles', 'first_seen', 'last_seen', 'url']];
  for (const i of r.persistence.items) {
    rows.push([
      i.title,
      i.type,
      i.standing,
      i.cycles,
      r.persistence.totalCycles,
      i.first_seen ? new Date(i.first_seen).toISOString().slice(0, 10) : '',
      i.last_seen ? new Date(i.last_seen).toISOString().slice(0, 10) : '',
      i.target_url || ''
    ]);
  }
  return rows
    .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','))
    .join('\n');
}
