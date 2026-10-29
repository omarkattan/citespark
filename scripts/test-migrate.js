import test from 'node:test';
import assert from 'node:assert/strict';
import {applySchema,retryableMigrationError} from '../src/db/migrate.js';

function fixture({failAt,code,message,recorded=false}={}) {
  const calls=[],releases=[];let connects=0;
  const pool={connect:async()=>{const id=++connects;return {
    query:async(sql,params)=>{
      calls.push({id,sql,params});
      if(id===1&&sql===failAt)throw Object.assign(new Error(message||'test failure'),{code});
      return {rows:sql.startsWith('SELECT schema_hash')&&recorded?[{schema_hash:'saved'}]:[]};
    },release:destroy=>releases.push({id,destroy})
  };}};
  return {pool,calls,releases};
}
const opts={sleep:async()=>{},log:()=>{}};
test('a terminated migration rolls back and retries the whole schema on a fresh connection',async()=>{
 const f=fixture({failAt:'test schema',message:'Connection terminated unexpectedly'});
 const result=await applySchema(f.pool,'test schema',opts);
 assert.equal(result.attempts,2);assert.deepEqual(f.releases,[{id:1,destroy:true},{id:2,destroy:false}]);
 assert.ok(f.calls.some(c=>c.id===1&&c.sql==='ROLLBACK'));
 assert.equal(f.calls.filter(c=>c.sql==='test schema').length,2);
 assert.equal(f.calls.filter(c=>c.sql.startsWith('INSERT INTO cited_schema_migrations')).length,1);
});
test('an unchanged schema does not rerun old ALTER statements or backfills',async()=>{
 const f=fixture({recorded:true});const result=await applySchema(f.pool,'test schema',opts);
 assert.equal(result.applied,false);assert.ok(!f.calls.some(c=>c.sql==='test schema'));assert.equal(f.calls.at(-1).sql,'COMMIT');
});
test('SQL errors fail immediately and cannot leave a successful migration receipt',async()=>{
 const f=fixture({failAt:'test schema',code:'42601'});
 await assert.rejects(applySchema(f.pool,'test schema',opts),{code:'42601'});
 assert.equal(f.releases.length,1);assert.ok(!f.calls.some(c=>c.sql.startsWith('INSERT INTO')));
});
test('connection retries are bounded and lock waits are short',async()=>{
 let connections=0;const calls=[];
 await assert.rejects(applySchema({connect:async()=>{connections++;throw Object.assign(new Error('lost'),{code:'ECONNRESET'});}},'test schema',opts));
 assert.equal(connections,3);const f=fixture();await applySchema(f.pool,'test schema',opts);
 assert.ok(f.calls.some(c=>c.sql==="SET LOCAL lock_timeout = '5s'"));assert.ok(f.calls.some(c=>c.sql.includes('pg_advisory_xact_lock')));
 for(const code of ['08006','57P01','55P03','40P01'])assert.equal(retryableMigrationError({code}),true);
 for(const code of ['42601','42501','23505','57014'])assert.equal(retryableMigrationError({code}),false);
});
