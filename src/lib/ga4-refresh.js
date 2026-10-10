// Durable refresh status and per-project locks shared by every web instance.
// No AI measurement is started by this service.
export function createGa4Refresh({ pool, sync, globalToken = false }) {
  let initialized, timer, ticking = false, active = 0;
  const ready = () => initialized ||= pool.query(`CREATE TABLE IF NOT EXISTS ga4_refresh_state (
    project_id integer PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    property_id text NOT NULL, state text NOT NULL DEFAULT 'queued',
    error text, next_attempt timestamptz NOT NULL DEFAULT now()
  )`).catch(error => { initialized = null; throw error; });

  async function enqueue(id) {
    await ready();
    await pool.query(`INSERT INTO ga4_refresh_state(project_id,property_id)
      SELECT id,ga4_property_id::text FROM projects WHERE id=$1 AND ga4_property_id IS NOT NULL
      ON CONFLICT(project_id) DO UPDATE SET property_id=excluded.property_id,state='queued',error=null,next_attempt=now()
      WHERE ga4_refresh_state.property_id<>excluded.property_id OR ga4_refresh_state.state<>'running'`, [id]);
  }
  async function status(id) {
    await ready();
    return (await pool.query(`SELECT s.state,s.error FROM ga4_refresh_state s JOIN projects p ON p.id=s.project_id
      WHERE p.id=$1 AND s.property_id=p.ga4_property_id::text`, [id])).rows[0] || null;
  }
  async function run(id, { onlyDue = false } = {}) {
    await ready();
    if (active >= 2) return { skipped: true, reason: 'Other Analytics imports are running. Please retry shortly.' };
    active++;
    let client;
    try { client = await pool.connect(); } catch (error) { active--; throw error; }
    let locked = false, property, broken = false;
    const controller = new AbortController();
    const lost = error => {
      broken = true;
      controller.abort(error instanceof Error ? error : new Error('Analytics database connection was lost. Please retry.'));
    };
    client.on('error', lost);
    client.on('end', lost);
    try {
      locked = (await client.query('SELECT pg_try_advisory_lock(52441,$1::integer) AS locked', [id])).rows[0].locked;
      if (!locked) return { skipped: true, reason: 'Analytics is already importing. Please wait for it to finish.' };
      if (onlyDue && !(await client.query('SELECT project_id FROM ga4_refresh_state WHERE project_id=$1 AND next_attempt<=now()', [id])).rows.length) {
        return { skipped: true, reason: 'Analytics is already up to date.' };
      }
      const project = (await client.query('SELECT ga4_property_id FROM projects WHERE id=$1', [id])).rows[0];
      property = project?.ga4_property_id;
      if (!property) return { skipped: true, reason: 'Choose an Analytics property first.' };
      await client.query(`INSERT INTO ga4_refresh_state(project_id,property_id,state,next_attempt) VALUES($1,$2,'running',now()+interval '20 minutes')
        ON CONFLICT(project_id) DO UPDATE SET property_id=excluded.property_id,state='running',error=null,next_attempt=excluded.next_attempt`, [id,String(property)]);
      const result = await sync(id, { signal: controller.signal });
      controller.signal.throwIfAborted();
      if (result.skipped) throw new Error(result.reason);
      await client.query(`UPDATE ga4_refresh_state SET state='ready',error=null,next_attempt=now()+interval '24 hours'
        WHERE project_id=$1 AND property_id=$2`, [id,String(property)]);
      return result;
    } catch (error) {
      if (locked && property) try { await (broken ? pool : client).query(`UPDATE ga4_refresh_state SET state='error',error=$3,next_attempt=now()+interval '1 hour'
        WHERE project_id=$1 AND property_id=$2`, [id,String(property),String(error.message || error).slice(0,500)]);
      } catch { /* A database outage can prevent status writes. The saved lease allows a later retry. */ }
      throw error;
    } finally {
      try {
        if (locked && !broken) await client.query('SELECT pg_advisory_unlock(52441,$1::integer)', [id]);
      } catch {
        broken = true; // Never return a client with an uncertain lock to the pool.
      } finally {
        try { client.release(broken); }
        finally {
          // A destroyed connection may emit another error while its socket closes.
          if (!broken) client.removeListener('error', lost);
          client.removeListener('end', lost);
          active--;
        }
      }
    }
  }
  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      await ready();
      // Catch existing connections and resume queued work after a restart.
      await pool.query(`INSERT INTO ga4_refresh_state(project_id,property_id,state,next_attempt)
        SELECT id,ga4_property_id::text,CASE WHEN ga4_sync_info->>'propertyId'=ga4_property_id::text AND ga4_synced_at IS NOT NULL THEN 'ready' ELSE 'queued' END,CASE WHEN ga4_sync_info->>'propertyId'=ga4_property_id::text THEN coalesce(ga4_synced_at+interval '24 hours',now()) ELSE now() END
        FROM projects WHERE ga4_property_id IS NOT NULL AND (ga4_refresh_token IS NOT NULL OR $1)
        ON CONFLICT(project_id) DO UPDATE SET property_id=excluded.property_id,state='queued',error=null,next_attempt=now()
        WHERE ga4_refresh_state.property_id<>excluded.property_id`, [globalToken]);
      const due = (await pool.query(`SELECT s.project_id FROM ga4_refresh_state s JOIN projects p ON p.id=s.project_id
        WHERE s.next_attempt<=now() AND p.ga4_property_id::text=s.property_id
        AND (p.ga4_refresh_token IS NOT NULL OR $1) ORDER BY s.next_attempt LIMIT 5`, [globalToken])).rows;
      for (const row of due) {
        try { await run(row.project_id, { onlyDue: true }); } catch { /* Saved error and retry time are visible in the UI. */ }
      }
    } finally { ticking = false; }
  }
  function start() {
    if (timer) return;
    const refresh = () => tick().catch(error => console.error('Analytics refresh service:', error.message));
    refresh();
    timer = setInterval(refresh, 60000);
    timer.unref?.();
  }
  return { enqueue, status, run, tick, start, stop() { clearInterval(timer); timer = null; } };
}
