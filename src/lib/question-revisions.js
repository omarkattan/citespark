import { pool } from '../db/index.js';

const fail = (status, message) => Object.assign(new Error(message), { status });

/** Every wording change gets a new identity, including an in-flight unmeasured question. */
export async function reviseQuestion({ orgId, promptId, text, expectedText }, database = pool) {
  text = String(text || '').trim();
  if (text.length < 10 || text.length > 500) throw fail(400, 'Use a question between 10 and 500 characters.');
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    const { rows: [old] } = await client.query(
      `SELECT q.* FROM prompts q JOIN projects p ON p.id = q.project_id
       WHERE q.id = $1 AND p.org_id = $2 FOR UPDATE OF q`, [promptId, orgId]);
    if (!old) throw fail(404, 'Question not found.');
    if (old.text !== expectedText) throw fail(409, 'This question changed. Refresh before editing it.');
    if (old.text === text) { await client.query('COMMIT'); return { question: old, unchanged: true }; }
    const { rows: existing } = await client.query(
      `SELECT id FROM prompts WHERE project_id = $1 AND
       (lower(trim(text)) = lower(trim($2)) OR revises_prompt_id = $3) LIMIT 1`, [old.project_id, text, old.id]);
    if (existing.length) throw fail(409, 'That wording is already tracked, or this question already has a newer revision.');
    // No allowance increase: a new active version replaces an active old version.
    const { rows: [question] } = await client.query(
      `INSERT INTO prompts (project_id, text, cluster, intent, ai_search_volume, source, persona_id, active, revises_prompt_id, origin_details)
       VALUES ($1,$2,$3,$4,NULL,$5,$6,$7,$8,$9::jsonb) RETURNING *`,
      [old.project_id, text, old.cluster, old.intent, old.source, old.persona_id, old.active, old.id, JSON.stringify(old.origin_details || {})]);
    await client.query('UPDATE prompts SET active = false WHERE id = $1', [old.id]);
    await client.query(
      `INSERT INTO prompt_events (project_id, prompt_id, event, text, previous, source)
       VALUES ($1,$2,'reworded',$3,$4,$5)`, [old.project_id, question.id, text, old.text, old.source]);
    await client.query('COMMIT');
    return { question, previousId: old.id };
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.code === '23505') throw fail(409, 'That question is already tracked.');
    throw error;
  } finally { client.release(); }
}
