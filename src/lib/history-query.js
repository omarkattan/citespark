/** Materialise the site's eligible rows once, rather than expanding the
 * published-answer view separately for the cohort, day count and result. */
export const comparableHistorySql = `WITH project_runs AS MATERIALIZED (
  SELECT id, prompt_id, engine, cycle_date
  FROM reporting_runs WHERE project_id=$1 AND ok
), pairs AS (
  SELECT prompt_id, engine, COUNT(DISTINCT cycle_date)::int AS seen
  FROM project_runs GROUP BY prompt_id, engine
), total AS (
  SELECT COUNT(DISTINCT cycle_date)::int AS n FROM project_runs
)
SELECT r.cycle_date AS date, COUNT(*)::int AS runs,
       SUM(CASE WHEN m.mentioned THEN 1 ELSE 0 END)::float / NULLIF(COUNT(*),0) AS rate
FROM project_runs r
JOIN mentions m ON m.run_id=r.id
JOIN entities e ON e.id=m.entity_id AND e.kind='owned'
JOIN pairs p ON p.prompt_id=r.prompt_id AND p.engine=r.engine
CROSS JOIN total t
WHERE p.seen=t.n
GROUP BY r.cycle_date ORDER BY r.cycle_date`;
