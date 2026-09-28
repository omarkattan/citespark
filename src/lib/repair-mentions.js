import { analyseRun } from './analyze.js';

export const MENTION_METHOD = 'visible-text-v2';

/** One project, one transaction. Only existing measured rows are eligible.
 * Caller supplies a dedicated pg client (or compatible test database).
 * Historical entity cohorts, citation records, raw answers and model choices
 * remain intact. Changes are computed again inside the apply transaction.
 */
export async function repairMentions(db, projectId, { apply = false } = {}) {
  await db.query('BEGIN');
  try {
    const { rows: projects } = await db.query('SELECT id, name FROM projects WHERE id = $1 FOR UPDATE', [projectId]);
    if (!projects.length) throw new Error(`No project ${projectId}`);
    const { rows: entities } = await db.query('SELECT * FROM entities WHERE project_id = $1 ORDER BY id FOR SHARE', [projectId]);
    const { rows } = await db.query(
      `SELECT m.run_id, m.entity_id, m.mentioned, m.ordinal, m.sentiment, m.snippet,
              r.response_text, r.cycle_date
       FROM mentions m JOIN runs r ON r.id = m.run_id
       WHERE r.project_id = $1 AND r.ok AND r.response_text IS NOT NULL
         AND length(trim(r.response_text)) > 0
       ORDER BY r.id, m.entity_id FOR UPDATE OF m`, [projectId]);
    const runs = new Map();
    for (const row of rows) {
      if (!runs.has(row.run_id)) runs.set(row.run_id, []);
      runs.get(row.run_id).push(row);
    }
    const summary = { projectId, name: projects[0].name, method: MENTION_METHOD,
      runs: runs.size, changed: 0, removed: 0, added: 0, ownedBefore: 0, ownedAfter: 0, ownedMeasured: 0 };
    for (const oldRows of runs.values()) {
      const measuredIds = new Set(oldRows.map(r => r.entity_id));
      const cohort = entities.filter(e => measuredIds.has(e.id));
      const results = await analyseRun({ text: oldRows[0].response_text, entities: cohort, useModel: false });
      for (const next of results) {
        const old = oldRows.find(r => r.entity_id === next.entity_id);
        if (cohort.find(e => e.id === next.entity_id)?.kind === 'owned') {
          summary.ownedMeasured++;
          summary.ownedBefore += Number(old.mentioned);
          summary.ownedAfter += Number(next.mentioned);
        }
        // Retain model-set sentiment for surviving mentions. An absent brand
        // cannot retain the snippet/sentiment of a discarded URL match.
        const sentiment = next.mentioned ? old.sentiment : null;
        if (old.mentioned === next.mentioned && old.ordinal === next.ordinal &&
            old.snippet === next.snippet && old.sentiment === sentiment) continue;
        summary.changed++;
        if (old.mentioned && !next.mentioned) summary.removed++;
        if (!old.mentioned && next.mentioned) summary.added++;
        if (apply) await db.query(
          `UPDATE mentions SET mentioned=$3, ordinal=$4, snippet=$5, sentiment=$6
           WHERE run_id=$1 AND entity_id=$2`,
          [old.run_id, old.entity_id, next.mentioned, next.ordinal, next.snippet, sentiment]);
      }
    }
    if (apply) {
      const note = `Brand naming corrected (${MENTION_METHOD})`;
      const { rows: prior } = await db.query('SELECT id FROM method_notes WHERE project_id=$1 AND note=$2 LIMIT 1', [projectId, note]);
      if (summary.changed || !prior.length) await db.query(
        'INSERT INTO method_notes (project_id, note, detail) VALUES ($1,$2,$3)',
        [projectId, note, `${summary.runs} retained successful answers re-read using literal visible-text matching. ` +
         `Link destinations, URL-only links and reference definitions no longer count as brand naming. ` +
         `${summary.changed} mention rows corrected, including ${summary.removed} removed and ${summary.added} added matches. ` +
         `Owned brand: ${summary.ownedBefore} to ${summary.ownedAfter} named out of ${summary.ownedMeasured} measured rows. ` +
         `Existing per-answer entity cohorts preserved. Missing, failed or empty answers were not reclassified. ` +
         `Citation records and original answer text unchanged. No engine or sentiment model called. ` +
         `This is a method correction, not a visibility change. Derived action history is not reprocessed.`]);
      await db.query('COMMIT');
    } else await db.query('ROLLBACK');
    return summary;
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
}
