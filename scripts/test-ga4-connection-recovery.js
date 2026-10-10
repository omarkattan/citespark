import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createGa4Refresh } from '../src/lib/ga4-refresh.js';
import { pool as productionPool } from '../src/db/index.js';
import { syncGa4, listProperties } from '../src/lib/ga4.js';

test('pool and checked-out clients handle asynchronous connection errors', () => {
  const client = new EventEmitter();
  productionPool.emit('connect', client);
  assert.doesNotThrow(() => client.emit('error',new Error('Connection terminated unexpectedly')));
  assert.doesNotThrow(() => productionPool.emit('error',new Error('Connection terminated unexpectedly')));
});

function fixture({ unlockFails = false, statusFails = false } = {}) {
  const clients = [], statements = [];
  const query = async (sql) => {
    statements.push(sql);
    if (sql.includes('pg_try_advisory_lock')) return {rows:[{locked:true}]};
    if (sql.includes('SELECT ga4_property_id')) return {rows:[{ga4_property_id:'123'}]};
    if (sql.includes('pg_advisory_unlock') && unlockFails) throw new Error('Unlock connection lost');
    if (sql.includes("SET state='error'") && statusFails) throw new Error('Database still unavailable');
    return {rows:[]};
  };
  const pool = {query,connect:async()=>{
    const client=Object.assign(new EventEmitter(),{query,release(destroy){client.destroyed=destroy;client.releases=(client.releases||0)+1;}});
    clients.push(client);return client;
  }};
  return {pool,clients,statements};
}

for (const event of ['error','end']) test(`lost lock connection (${event}) aborts import and allows a later retry`,async()=>{
  const f=fixture();let calls=0;
  const service=createGa4Refresh({pool:f.pool,sync:async(id,{signal})=>{
    calls++;
    if(calls===1){
      const pending=new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
      f.clients[0].emit(event,new Error('Connection terminated unexpectedly'));
      return pending;
    }
    return {written:2};
  }});
  await assert.rejects(service.run(1),/Connection terminated unexpectedly/);
  assert.equal(f.clients[0].destroyed,true);assert.equal(f.clients[0].releases,1);
  assert.equal(f.statements.some(sql=>sql.includes('pg_advisory_unlock')),false);
  assert.equal(f.statements.some(sql=>sql.includes("SET state='ready'")),false);
  assert.doesNotThrow(()=>f.clients[0].emit('error',new Error('late socket error')));
  assert.equal((await service.run(1)).written,2);
});

test('status-write failure does not replace the original disconnect error',async()=>{
  const f=fixture({statusFails:true});
  const service=createGa4Refresh({pool:f.pool,sync:async()=>{
    f.clients[0].emit('error',new Error('Original disconnect'));throw new Error('Original disconnect');
  }});
  await assert.rejects(service.run(1),/Original disconnect/);
  assert.equal(f.clients[0].destroyed,true);
});

test('failed unlock destroys the connection and does not leak capacity',async()=>{
  const f=fixture({unlockFails:true});
  const service=createGa4Refresh({pool:f.pool,sync:async()=>({written:1})});
  for(let i=0;i<3;i++)assert.equal((await service.run(1)).written,1);
  assert.equal(f.clients.length,3);assert.ok(f.clients.every(c=>c.destroyed&&c.releases===1));
});

test('cancelled real GA4 sync cannot begin writes or publish partial data',async()=>{
  const controller=new AbortController();controller.abort(new Error('Lock lost'));
  await assert.rejects(syncGa4(1,{signal:controller.signal}),/Lock lost/);
});

test('mid-request cancellation stops GA4 fetch and property listing still works',async()=>{
  const originalFetch=global.fetch, originalQuery=productionPool.query, originalConnect=productionPool.connect;
  const previousToken=process.env.GOOGLE_REFRESH_TOKEN;
  const controller=new AbortController();let entered,writes=0;
  const fetching=new Promise(resolve=>entered=resolve);
  process.env.GOOGLE_REFRESH_TOKEN='test';
  productionPool.query=async()=>({rows:[{id:1,ga4_property_id:'123'}]});
  productionPool.connect=async()=>{writes++;throw new Error('Must not begin writes');};
  global.fetch=async(url,options)=>{
    if(String(url).includes('oauth2'))return {ok:true,json:async()=>({access_token:'test'})};
    if(String(url).includes('analyticsadmin'))return {ok:true,json:async()=>({accountSummaries:[]})};
    entered();return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}));
  };
  try{
    assert.deepEqual(await listProperties({}),[]);
    const pending=syncGa4(1,{signal:controller.signal});await fetching;
    controller.abort(new Error('Connection terminated unexpectedly'));
    await assert.rejects(pending,/Connection terminated unexpectedly/);assert.equal(writes,0);
  }finally{
    global.fetch=originalFetch;productionPool.query=originalQuery;productionPool.connect=originalConnect;
    if(previousToken===undefined)delete process.env.GOOGLE_REFRESH_TOKEN;else process.env.GOOGLE_REFRESH_TOKEN=previousToken;
  }
});
