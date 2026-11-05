import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';

export function retryableMigrationError(error) {
  return /^(08|57P0[123]$)/.test(error?.code||'') ||
    ['ECONNRESET','ECONNREFUSED','EPIPE','ETIMEDOUT','55P03','40P01'].includes(error?.code) ||
    /connection (?:terminated|closed|lost)|connection timeout|timeout exceeded when trying to connect/i.test(error?.message||'');
}

// A reviewed upgrade applies only the changes between two exact schema hashes.
// Fresh installs and unrecognised versions retain the full-schema path. Either
// path commits with its receipt, or rolls back and retries on a fresh connection.
export async function applySchema(pool,sql,{attempts=3,sleep=delay,log=console.log,upgrades=[]}={}) {
  const hash=createHash('sha256').update(sql).digest('hex');
  for(let attempt=1;attempt<=attempts;attempt++) {
    let client,failed=false,stage='connect';
    try {
      client=await pool.connect();
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '5s'");
      await client.query("SET LOCAL statement_timeout = '90s'");
      // Transaction-scoped lock also releases when a connection is lost.
      await client.query('SELECT pg_advisory_xact_lock(1145656389, 1)');
      await client.query('CREATE TABLE IF NOT EXISTS cited_schema_migrations (schema_hash TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
      const prior=await client.query('SELECT schema_hash FROM cited_schema_migrations WHERE schema_hash=$1',[hash]);
      if(prior.rows.length) {
        await client.query('COMMIT');
        log('Schema unchanged. No schema statements reapplied.');
        return {applied:false,hash,attempts:attempt};
      }
      const latest=await client.query('SELECT schema_hash FROM cited_schema_migrations ORDER BY applied_at DESC, schema_hash LIMIT 1');
      const upgrade=upgrades.find(item=>item.from===latest.rows[0]?.schema_hash && item.to===hash);
      if(upgrade) {
        log(`Applying targeted schema upgrade: ${upgrade.name}.`);
        for(const step of upgrade.steps) {
          stage=step.name;
          log(`Migration step: ${stage}.`);
          await client.query(step.sql);
        }
      } else {
        stage='full schema';
        log('Applying full schema (no matching targeted upgrade).');
        await client.query(sql);
      }
      stage='record schema receipt';
      await client.query('INSERT INTO cited_schema_migrations(schema_hash) VALUES($1)',[hash]);
      await client.query('COMMIT');
      log('Schema applied and recorded.');
      return {applied:true,hash,attempts:attempt};
    } catch(error) {
      failed=true;
      if(client)await client.query('ROLLBACK').catch(()=>{});
      log(`Migration failed during ${stage} (${error.code||'connection_closed'}).`);
      if(!retryableMigrationError(error)||attempt===attempts)throw error;
      log(`Migration connection or lock interrupted. Retrying ${attempt+1}/${attempts}.`);
    } finally {
      client?.release(failed);
    }
    await sleep(1000*attempt);
  }
}
