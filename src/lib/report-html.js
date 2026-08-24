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

/** A trend line, drawn small. Inline SVG so it survives printing and email. */
function sparkline(points, { w = 620, h = 120 } = {}) {
  if (points.length < 2) return '';
  const pad = 14;
  const max = Math.max(...points.map((p) => p.rate || 0), 0.1);
  const x = (i) => pad + (i / (points.length - 1)) * (w - pad * 2);
  const y = (v) => h - pad - ((v || 0) / max) * (h - pad * 2);

  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.rate).toFixed(1)}`).join(' ');
  const area = `${line} L${x(points.length - 1).toFixed(1)},${h - pad} L${x(0).toFixed(1)},${h - pad} Z`;

  return `<svg class="spark" viewBox="0 0 ${w} ${h}" role="img" aria-label="Visibility over time">
    <path d="${area}" fill="#157a4a" opacity="0.08" />
    <path d="${line}" fill="none" stroke="#157a4a" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
    ${points
      .map(
        (p, i) =>
          `<circle cx="${x(i).toFixed(1)}" cy="${y(p.rate).toFixed(1)}" r="${i === points.length - 1 ? 4.5 : 3}" fill="${
            i === points.length - 1 ? '#157a4a' : '#fff'
          }" stroke="#157a4a" stroke-width="2" />`
      )
      .join('')}
  </svg>`;
}

/** A share, drawn as a ring. Easier to compare at a glance than a number. */
function ring(pct, label, tone = 'good') {
  const size = 92;
  const rad = 34;
  const circ = 2 * Math.PI * rad;
  const on = Math.max(0, Math.min(100, pct));
  const colour = tone === 'bad' ? '#b3261e' : tone === 'warn' ? '#a8601b' : '#157a4a';

  return `<div class="ring">
    <svg viewBox="0 0 ${size} ${size}" role="img" aria-label="${escapeHtmlAttr(label)}: ${on}%">
      <circle cx="${size / 2}" cy="${size / 2}" r="${rad}" fill="none" stroke="#eef1ef" stroke-width="9" />
      <circle cx="${size / 2}" cy="${size / 2}" r="${rad}" fill="none" stroke="${colour}" stroke-width="9"
        stroke-linecap="round" stroke-dasharray="${((on / 100) * circ).toFixed(1)} ${circ.toFixed(1)}"
        transform="rotate(-90 ${size / 2} ${size / 2})" />
      <text x="${size / 2}" y="${size / 2 + 6}" text-anchor="middle" font-size="21" font-weight="600" fill="#14161a">${on}%</text>
    </svg>
    <span>${label}</span>
  </div>`;
}

const escapeHtmlAttr = (s) => String(s == null ? '' : s).replace(/"/g, '&quot;');

export function reportHtml(r, { print = false } = {}) {
  const recurring = r.persistence.items.filter((i) => i.standing === 'recurring');
  const persistentSources = r.sources.sources.filter((s) => s.persistent).slice(0, 12);
  const changeWord = r.trend.change === null ? null : r.trend.change > 0.02 ? 'up' : r.trend.change < -0.02 ? 'down' : 'flat';

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<title>${esc(r.project.name)} AI visibility report ${date(r.generatedAt)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  @page { size: A4; margin: 16mm 14mm; }
  * { box-sizing: border-box; }
  body {
    font: 15px/1.62 -apple-system, system-ui, "Segoe UI", sans-serif;
    color: #14161a; max-width: 860px; margin: 0 auto; padding: 44px 26px 90px; background: #fff;
  }

  .masthead { border-bottom: 3px solid #14161a; padding-bottom: 18px; margin-bottom: 34px; }
  .masthead .kicker {
    font-family: ui-monospace, Menlo, monospace; font-size: 10.5px; letter-spacing: .16em;
    text-transform: uppercase; color: #75887c; margin-bottom: 10px;
  }
  h1 { font-size: 34px; line-height: 1.12; margin: 0 0 8px; letter-spacing: -.015em; }
  .sub { color: #5d7268; font-size: 14px; margin: 0; }

  h2 {
    font-size: 12px; letter-spacing: .14em; text-transform: uppercase;
    font-family: ui-monospace, Menlo, monospace; font-weight: 500; color: #75887c;
    margin: 46px 0 14px; padding-bottom: 8px; border-bottom: 1px solid #e3e7e4;
  }
  h2:first-of-type { margin-top: 0; }
  p { margin: 0 0 12px; }
  .lede { font-size: 19px; line-height: 1.5; color: #14161a; margin-bottom: 22px; }
  .lede b { background: linear-gradient(transparent 62%, #cdebd9 62%); padding: 0 2px; }

  /* headline figures */
  .cards { display: flex; gap: 14px; flex-wrap: wrap; margin: 0 0 26px; }
  .card { flex: 1 1 150px; border: 1px solid #e3e7e4; border-radius: 8px; padding: 16px 18px; }
  .card .k {
    font-family: ui-monospace, Menlo, monospace; font-size: 9.5px; letter-spacing: .13em;
    text-transform: uppercase; color: #75887c; margin-bottom: 8px;
  }
  .card .v { font-size: 30px; line-height: 1; font-weight: 600; letter-spacing: -.02em; }
  .card .v.bad { color: #b3261e; }
  .card .v.good { color: #157a4a; }
  .card .s { font-size: 12.5px; color: #5d7268; margin-top: 7px; line-height: 1.45; }

  .spark { width: 100%; height: auto; display: block; margin: 6px 0 18px; }
  .rings { display: flex; gap: 26px; flex-wrap: wrap; align-items: flex-start; margin: 4px 0 20px; }
  .ring { text-align: center; width: 100px; }
  .ring svg { width: 92px; height: 92px; }
  .ring span { display: block; font-size: 12px; color: #5d7268; line-height: 1.35; margin-top: 4px; }

  table { width: 100%; border-collapse: collapse; margin: 10px 0 6px; font-size: 14px; }
  th {
    text-align: left; font-family: ui-monospace, Menlo, monospace; font-size: 9.5px;
    letter-spacing: .12em; text-transform: uppercase; color: #75887c; font-weight: 500;
    padding: 0 10px 8px 0; border-bottom: 1px solid #e3e7e4;
  }
  td { padding: 11px 10px 11px 0; border-bottom: 1px solid #f0f3f1; vertical-align: top; }
  tr:last-child td { border-bottom: none; }
  td.num, th.num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }

  .barcell { width: 190px; }
  .bar { display: block; height: 10px; background: #eef1ef; border-radius: 3px; overflow: hidden; }
  .bar i { display: block; height: 100%; background: #157a4a; border-radius: 3px; }
  .bar.warm i { background: #a8601b; }
  .bar.hot i { background: #b3261e; }

  .tag {
    display: inline-block; font-family: ui-monospace, Menlo, monospace; font-size: 9.5px;
    letter-spacing: .08em; text-transform: uppercase; border: 1px solid #cfd8d2;
    border-radius: 3px; padding: 2px 7px; color: #5d7268; white-space: nowrap;
  }
  .tag.hot { border-color: #b3261e; color: #b3261e; }
  .tag.warm { border-color: #a8601b; color: #a8601b; }

  .note { font-size: 13.5px; color: #5d7268; line-height: 1.6; }
  .callout {
    border-left: 3px solid #157a4a; background: #f4f9f6; padding: 14px 18px;
    border-radius: 0 6px 6px 0; margin: 16px 0; font-size: 14px; line-height: 1.6;
  }
  .callout.warn { border-left-color: #a8601b; background: #fdf7ef; }
  .caveats {
    margin-top: 50px; padding: 20px 22px; background: #f5f7f6;
    border-radius: 8px; font-size: 13.5px; color: #3d4a42;
  }
  .caveats b { display: block; margin-bottom: 8px; }
  .caveats li { margin-bottom: 7px; }
  .foot { margin-top: 42px; padding-top: 16px; border-top: 1px solid #e3e7e4; font-size: 12px; color: #75887c; }
  a { color: #157a4a; word-break: break-word; }
  .url { font-family: ui-monospace, Menlo, monospace; font-size: 11.5px; color: #75887c; }

  @media print {
    body { padding: 0; max-width: none; }
    h2 { page-break-after: avoid; }
    table, .card, .callout, .ring { page-break-inside: avoid; }
    .cards { page-break-inside: avoid; }
  }
</style></head>
<body>

<div class="masthead">
  <p class="kicker">AI visibility report &middot; ${date(r.generatedAt)}</p>
  <h1>${esc(r.project.name)}</h1>
  <p class="sub">
    ${esc(r.project.domain)} &middot; ${r.trend.cycles} measurement ${r.trend.cycles === 1 ? 'cycle' : 'cycles'}${
      r.period?.from && r.period?.to ? ` &middot; ${date(r.period.from)} to ${date(r.period.to)}` : ''
    }
  </p>
</div>

<h2>Where things stand</h2>
${
  r.trend.cycles
    ? `<p class="lede">
        ${esc(r.project.brand)} was named in <b>${pct(r.trend.last)}</b> of answers in the most recent cycle${
          changeWord && r.trend.cycles > 1
            ? `, ${changeWord === 'flat' ? 'about level with' : `${changeWord} from`} ${pct(r.trend.first)} when we started`
            : ''
        }.
      </p>

      <div class="cards">
        <div class="card">
          <div class="k">Named in</div>
          <!--
            Deliberately uncoloured. This is a level, not a change, and there
            is no threshold at which a share of answers is good or bad without
            knowing the category. Colouring it red made a neutral fact read as
            a failure. The competitor table below is what says whether it is
            good, because that comparison is the only one with meaning.
          -->
          <div class="v">${pct(r.trend.last)}</div>
          <div class="s">of answers, most recent cycle</div>
        </div>
        <div class="card">
          <div class="k">Movement</div>
          <div class="v ${r.trend.change > 0.02 ? 'good' : r.trend.change < -0.02 ? 'bad' : ''}">${
            r.trend.change === null ? '&mdash;' : `${r.trend.change > 0 ? '+' : ''}${Math.round(r.trend.change * 100)}`
          }<span style="font-size:16px">pts</span></div>
          <div class="s">since the first cycle</div>
        </div>
        <div class="card">
          <div class="k">Your site cited</div>
          <!-- Zero is a genuine problem; anything else is not, and being
               cited in every cycle is worth showing as a win. -->
          <div class="v ${
            r.sources.ownCited === 0 ? 'bad' : r.sources.ownCited === r.sources.totalCycles ? 'good' : ''
          }">${r.sources.ownCited}<span style="font-size:16px;color:#75887c"> / ${r.sources.totalCycles}</span></div>
          <div class="s">cycles where an answer used your own site as a source</div>
        </div>
        <div class="card">
          <div class="k">Standing problems</div>
          <!-- A count of outstanding work is not a failure. Red here made
               every report look like an emergency regardless of the number. -->
          <div class="v">${recurring.length}</div>
          <div class="s">actions present in most cycles</div>
        </div>
      </div>

      ${sparkline(r.trend.points)}

      <table><thead><tr><th>Cycle</th><th class="num">Questions</th><th class="num">Named in</th><th class="barcell"></th></tr></thead><tbody>
      ${r.trend.points
        .map(
          (p) => `<tr>
            <td>${date(p.cycle_date)}</td>
            <td class="num">${p.questions}</td>
            <td class="num">${pct(p.rate)}</td>
            <td class="barcell"><span class="bar"><i style="width:${Math.round((p.rate || 0) * 100)}%"></i></span></td>
          </tr>`
        )
        .join('')}
      </tbody></table>`
    : '<p>No cycles have completed yet.</p>'
}

<h2>What keeps coming back</h2>
<p class="note">
  Actions that recur cycle after cycle are structural: the thing causing them has not changed. Fixing one of these
  removes a problem permanently rather than for a week.
</p>
${
  recurring.length
    ? `<table><thead><tr><th>Action</th><th class="num">Seen in</th><th class="barcell"></th><th class="num">Since</th></tr></thead><tbody>
      ${recurring
        .slice(0, 15)
        .map(
          (i) => `<tr>
            <td><b>${esc(i.title)}</b>${i.target_url ? `<br /><span class="url">${esc(i.target_url.slice(0, 76))}</span>` : ''}</td>
            <td class="num">${i.cycles}/${r.persistence.totalCycles}</td>
            <td class="barcell"><span class="bar ${i.share === 1 ? 'hot' : 'warm'}"><i style="width:${Math.round(i.share * 100)}%"></i></span></td>
            <td class="num">${date(i.first_seen)}</td>
          </tr>`
        )
        .join('')}
      </tbody></table>`
    : `<p>Nothing has recurred yet. ${r.persistence.totalCycles < 3 ? 'Three cycles are needed before a pattern can be called one.' : ''}</p>`
}

<h2>Who gets cited, and whether you ever do</h2>
${
  persistentSources.length
    ? `${
        r.standings?.length > 1
          ? `<p class="note">Where you sit against the competitors you track, in the most recent cycle.</p>
            <table><thead><tr><th>Brand</th><th class="num">Named in</th><th class="barcell"></th></tr></thead><tbody>
            ${r.standings
              .map(
                (b) => `<tr>
                  <td>${b.kind === 'owned' ? `<b>${esc(b.name)}</b> <span class="tag">you</span>` : esc(b.name)}</td>
                  <td class="num">${pct(b.rate)}</td>
                  <td class="barcell"><span class="bar ${b.kind === 'owned' ? '' : 'warm'}"><i style="width:${Math.round((b.rate || 0) * 100)}%"></i></span></td>
                </tr>`
              )
              .join('')}
            </tbody></table>`
          : ''
      }

      <p class="note" style="margin-top:18px">
        The sources answers are built from in your category. Your own domain was cited in
        <b>${r.sources.ownCited} of ${r.sources.totalCycles}</b> cycles.
      </p>

      <table><thead><tr><th>Source</th><th class="num">Cycles</th><th class="num">Questions</th><th class="num">Citations</th></tr></thead><tbody>
      ${persistentSources
        .map(
          (s) => `<tr>
            <td><b>${esc(s.domain)}</b> ${s.cycles === r.sources.totalCycles ? '<span class="tag hot">every cycle</span>' : ''}
              ${s.example_url ? `<br /><span class="url">${esc(s.example_url.slice(0, 76))}</span>` : ''}</td>
            <td class="num">${s.cycles}</td>
            <td class="num">${s.questions}</td>
            <td class="num">${s.citations}</td>
          </tr>`
        )
        .join('')}
      </tbody></table>
      <div class="callout">
        A source appearing in every cycle is not a passing mention. It is part of how this category gets answered,
        and being absent from it is a standing disadvantage.
      </div>`
    : '<p>Not enough cycles yet to say which sources persist.</p>'
}

<h2>What the pages being cited have in common</h2>
${
  r.patterns.pages
    ? `<div class="callout${r.patterns.thin ? ' warn' : ''}">
        <b>How this was measured.</b>
        Read from <b>${r.patterns.pages}</b> of the ${r.patterns.universe} pages cited in answers to your questions.
        The most-cited pages are read automatically at the end of each cycle, and any page you asked about yourself is
        included too.
        ${
          r.patterns.thin
            ? ' At this sample size treat the shares below as indicative rather than settled: run more cycles and they will firm up.'
            : ''
        }
        ${r.patterns.medianWords ? ` Median length ${r.patterns.medianWords.toLocaleString()} words.` : ''}
      </div>

      <table><thead><tr><th>Feature</th><th class="num">Share of cited pages</th><th class="barcell"></th></tr></thead><tbody>
      ${r.patterns.features
        .map(
          ([label, p]) => `<tr>
            <td>${esc(label)}</td>
            <td class="num">${p}%</td>
            <td class="barcell"><span class="bar"><i style="width:${p}%"></i></span></td>
          </tr>`
        )
        .join('')}
      </tbody></table>
      ${
        r.patterns.schemaTypes.length
          ? `<p class="note">Most common structured data on cited pages: ${r.patterns.schemaTypes.map(([t, n]) => `${esc(t)} (${n})`).join(', ')}.</p>`
          : ''
      }`
    : `<div class="callout warn">${esc(r.patterns.note)}</div>`
}

${
  r.personas?.length > 1
    ? `<h2>Who can see you, and who cannot</h2>
      <p class="note">
        The same question gets a different answer depending on who is asking. A single visibility figure averages
        those together and hides the buyers you are invisible to.
      </p>
      <table><thead><tr><th>Buyer type</th><th class="num">Questions</th><th class="num">Named in</th><th class="barcell"></th><th class="num">Average position</th></tr></thead><tbody>
      ${r.personas
        .map(
          (p) => `<tr>
            <td><b>${esc(p.persona)}</b>${p.descriptor ? `<br /><span class="url">${esc(String(p.descriptor).slice(0, 80))}</span>` : ''}</td>
            <td class="num">${p.questions}</td>
            <td class="num">${pct(p.named_rate)}</td>
            <!--
              Coloured against the other audiences rather than an absolute
              threshold: the point of this table is which buyer is worst
              served, and that is only meaningful relative to the rest.
            -->
            <td class="barcell"><span class="bar ${
              r.personas.length > 1 && p.named_rate === Math.min(...r.personas.map((x) => x.named_rate || 0)) ? 'hot' : ''
            }"><i style="width:${Math.round((p.named_rate || 0) * 100)}%"></i></span></td>
            <td class="num">${p.avg_position ? p.avg_position.toFixed(1) : '&mdash;'}</td>
          </tr>`
        )
        .join('')}
      </tbody></table>
      ${(() => {
        const best = r.personas[0];
        const worst = r.personas[r.personas.length - 1];
        const gap = Math.round(((best.named_rate || 0) - (worst.named_rate || 0)) * 100);
        return gap >= 15
          ? `<div class="callout warn">
              <b>${gap} points separate your best and worst audience.</b>
              ${esc(best.persona)} sees you in ${pct(best.named_rate)} of answers; ${esc(worst.persona)} sees you in
              ${pct(worst.named_rate)}. That gap is a content problem with a specific audience attached, which is a
              more tractable brief than raising visibility in general.
            </div>`
          : '';
      })()}`
    : ''
}

<h2>What the assistants actually sent</h2>
${
  r.traffic?.total
    ? `<div class="cards">
        <div class="card">
          <div class="k">Sessions</div>
          <div class="v good">${r.traffic.total.toLocaleString()}</div>
          <div class="s">from AI assistants, last ${r.traffic.days} days</div>
        </div>
        <div class="card">
          <div class="k">Conversions</div>
          <div class="v">${Math.round(r.traffic.conversions).toLocaleString()}</div>
          <div class="s">recorded against those sessions</div>
        </div>
        ${
          r.traffic.revenue
            ? `<div class="card">
                <div class="k">Revenue</div>
                <div class="v good">$${Math.round(r.traffic.revenue).toLocaleString()}</div>
                <div class="s">attributed in Analytics</div>
              </div>`
            : ''
        }
      </div>

      <table><thead><tr><th>Assistant</th><th class="num">Sessions</th><th class="barcell"></th><th class="num">Conversions</th></tr></thead><tbody>
      ${(() => {
        const top = Math.max(...r.traffic.sources.map((x) => x.sessions), 1);
        return r.traffic.sources
          .map(
            (x) => `<tr>
              <td>${esc(x.source)}</td>
              <td class="num">${x.sessions.toLocaleString()}</td>
              <td class="barcell"><span class="bar"><i style="width:${Math.round((x.sessions / top) * 100)}%"></i></span></td>
              <td class="num">${Math.round(x.conversions).toLocaleString()}</td>
            </tr>`
          )
          .join('');
      })()}
      </tbody></table>

      ${
        r.traffic.pages?.length
          ? `<h3 style="font-size:14px;margin:26px 0 4px">Where they landed</h3>
            <table><thead><tr><th>Page</th><th class="num">Sessions</th><th class="num">Conversions</th></tr></thead><tbody>
            ${r.traffic.pages
              .map(
                (p) => `<tr>
                  <td><span class="url">${esc(p.page.slice(0, 76))}</span></td>
                  <td class="num">${p.sessions.toLocaleString()}</td>
                  <td class="num">${Math.round(p.conversions).toLocaleString()}</td>
                </tr>`
              )
              .join('')}
            </tbody></table>`
          : ''
      }

      <div class="callout">
        Everything above this section is a leading indicator. This is the part that pays for the work, and it is the
        number to watch as the visibility figures move.
      </div>`
    : `<div class="callout warn">${esc(r.traffic?.why || 'No Analytics data is available for this site.')}</div>`
}

${
  r.themes?.length
    ? `<h2>What the findings come down to</h2>
      <p class="note">
        The same problem often appears once per question. Grouped, the list is short enough to act on.
      </p>
      <table><thead><tr><th>Theme</th><th class="num">Questions affected</th><th class="num">Recurring</th></tr></thead><tbody>
      ${r.themes
        .slice(0, 10)
        .map(
          (t) => `<tr>
            <td><b>${esc(t.label)}</b></td>
            <td class="num">${t.items.length}</td>
            <td class="num">${t.recurring ? `<span class="tag hot">${t.recurring}</span>` : '&mdash;'}</td>
          </tr>`
        )
        .join('')}
      </tbody></table>`
    : ''
}

<h2>Every finding, in full</h2>
<table><thead><tr><th>Action</th><th class="num">Standing</th><th class="num">Seen in</th></tr></thead><tbody>
${r.persistence.items
  .slice(0, 40)
  .map(
    (i) => `<tr>
      <td>${esc(i.title)}</td>
      <td class="num"><span class="tag${i.standing === 'recurring' ? ' hot' : i.standing === 'intermittent' ? ' warm' : ''}">${i.standing}</span></td>
      <td class="num">${i.cycles}/${r.persistence.totalCycles}</td>
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

${
  print
    ? `<script>
        /*
         * Straight to the save dialog, with the filename already set by the
         * document title. A real server-side PDF would mean running Chromium
         * on a 512MB instance, which would cost more in reliability than it
         * gains in polish.
         */
        window.addEventListener('load', function () { setTimeout(function () { window.print(); }, 350); });
      </script>`
    : ''
}

<p class="foot">
  Generated by Cited&trade; on ${date(r.generatedAt)} from ${r.trend.cycles} measurement ${r.trend.cycles === 1 ? 'cycle' : 'cycles'}.
  Another Sandstorm Digital&reg; Production.
</p>
</body></html>`;
}

/** The same actions as a spreadsheet, for anyone who wants to sort them. */
/**
 * Everything the report knows, as one spreadsheet.
 *
 * This exported the action list alone, which is the least of what has been
 * measured: the citations, the traffic and the landing pages were all missing,
 * so anyone wanting to do their own analysis had to go back and ask.
 *
 * One file with a section column rather than several files, because a single
 * attachment is what actually reaches a client.
 */
/**
 * Everything measured, in one file, as sections.
 *
 * This held only the action list, which is the smallest and least reusable
 * part of what we know. A client asking for the data wants the citations, the
 * traffic and the questions too, and one file with labelled sections is
 * easier to hand over than four.
 */
export function reportCsv(r) {
  const rows = [];
  const section = (title, header, body) => {
    if (!body.length) return;
    if (rows.length) rows.push([]);
    rows.push([`# ${title}`]);
    rows.push(header);
    rows.push(...body);
  };

  const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');

  section(
    'Summary',
    ['metric', 'value'],
    [
      ['Brand', r.project.brand],
      ['Domain', r.project.domain],
      ['Generated', day(r.generatedAt)],
      ['Measurement cycles', r.trend.cycles],
      ['Named in, most recent cycle', r.trend.last == null ? '' : `${Math.round(r.trend.last * 100)}%`],
      ['Measured on a like-for-like question set', r.trend.comparable ? 'yes' : 'no'],
      ['Questions in that set', r.trend.comparableCount || ''],
      ['Times named, first cycle', r.trend.firstNamed ?? ''],
      ['Times named, latest cycle', r.trend.lastNamed ?? ''],
      ['Questions asked, first cycle', r.trend.firstQuestions ?? ''],
      ['Questions asked, latest cycle', r.trend.lastQuestions ?? ''],
      ['Cycles citing our own site', `${r.sources.ownCited} of ${r.sources.totalCycles}`],
      ['AI sessions, last 90 days', r.traffic?.total ?? 'not connected'],
      ['Conversions from AI traffic', r.traffic?.conversions ?? '']
    ]
  );

  section(
    'Visibility by cycle',
    ['cycle_date', 'questions_asked', 'named_in_pct'],
    (r.trend.all || []).map((p) => [day(p.cycle_date), p.questions, Math.round((p.rate || 0) * 100)])
  );

  section(
    'Where we stand against tracked competitors',
    ['brand', 'is_us', 'named_in_pct'],
    (r.standings || []).map((b) => [b.name, b.kind === 'owned' ? 'yes' : 'no', Math.round((b.rate || 0) * 100)])
  );

  section(
    'AI traffic by assistant, last 90 days',
    ['assistant', 'sessions', 'conversions'],
    (r.traffic?.sources || []).map((x) => [x.source, x.sessions, Math.round(x.conversions)])
  );

  // The pages assistants actually send people to, which is the thing a
  // client can act on directly.
  section(
    'Pages AI traffic lands on',
    ['url', 'sessions', 'conversions', 'conversion_rate_pct'],
    (r.traffic?.pages || []).map((p) => [
      p.page,
      p.sessions,
      Math.round(p.conversions),
      p.sessions ? Math.round((p.conversions / p.sessions) * 100) : 0
    ])
  );

  section(
    'Sources shaping answers in this category',
    ['domain', 'cycles_seen', 'questions', 'citations', 'appears_every_cycle', 'example_url'],
    (r.sources.sources || []).map((x) => [
      x.domain,
      x.cycles,
      x.questions,
      x.citations,
      x.persistent ? 'yes' : 'no',
      x.example_url || ''
    ])
  );

  section(
    'What cited pages have in common',
    ['feature', 'share_of_cited_pages_pct'],
    (r.patterns?.features || []).map(([label, pctValue]) => [label, pctValue])
  );

  section(
    'Findings grouped by theme',
    ['theme', 'questions_affected', 'recurring'],
    (r.themes || []).map((t) => [t.label, t.items.length, t.recurring])
  );

  section(
    'Every finding',
    ['title', 'type', 'standing', 'cycles_seen', 'total_cycles', 'first_seen', 'last_seen', 'url'],
    (r.persistence.items || []).map((i) => [
      i.title,
      i.type,
      i.standing,
      i.cycles,
      r.persistence.totalCycles,
      day(i.first_seen),
      day(i.last_seen),
      i.target_url || ''
    ])
  );

  section(
    'Completed',
    ['title', 'completed_on'],
    (r.completed || []).map((c) => [c.title, day(c.completed_at)])
  );

  section('How to read this', ['note'], (r.caveats || []).map((c) => [c]));

  return rows
    .map((row) => row.map((cell) => `"${String(cell ?? '').replace(/"/g, '""')}"`).join(','))
    .join('\r\n');
}
