import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createGa4Refresh } from '../src/lib/ga4-refresh.js';
const { PGlite } = await import(process.env.PGLITE_MODULE);

async function fixture() {
  const db = new PGlite();
  await db.exec(`CREATE TABLE projects(id integer PRIMARY KEY,ga4_property_id text,ga4_refresh_token text,ga4_synced_at timestamptz,ga4_sync_info jsonb);
    INSERT INTO projects VALUES(1,'123','test',null,null),(2,null,'test',null,null),(3,'789',null,null,null);`);
  const locks = new Set();
  const pool = { query: (...args) => db.query(...args), connect: async () => ({
    query: (sql,args) => {
      if (sql.includes('pg_try_advisory_lock')) { const locked = !locks.has(args[0]); if (locked) locks.add(args[0]); return Promise.resolve({rows:[{locked}]}); }
      if (sql.includes('pg_advisory_unlock')) { locks.delete(args[0]); return Promise.resolve({rows:[]}); }
      return db.query(sql,args);
    }, release() {}
  }) };
  return { db, pool };
}

test('first import, daily refresh, existing connections and restart recovery', async () => {
  const {db,pool}=await fixture(); let calls=0;
  const sync=async id=>{calls++;await db.query("UPDATE projects SET ga4_synced_at=now(),ga4_sync_info=jsonb_build_object('propertyId',ga4_property_id) WHERE id=$1",[id]);return {written:0};};
  const service=createGa4Refresh({pool,sync});
  try {
    await db.exec(`INSERT INTO projects VALUES(4,'999','test',now(),'{"propertyId":"999"}')`);
    await service.tick(); assert.equal(calls,1); assert.equal((await service.status(1)).state,'ready');
    assert.equal((await service.status(4)).state,'ready');
    await service.tick(); assert.equal(calls,1);
    await db.exec("UPDATE ga4_refresh_state SET next_attempt=now()-interval '1 second' WHERE project_id=1");
    await service.tick(); assert.equal(calls,2);
    await service.enqueue(1);
    await createGa4Refresh({pool,sync}).tick(); assert.equal(calls,3);
    await db.exec("UPDATE ga4_refresh_state SET state='running',next_attempt=now()-interval '1 second' WHERE project_id=1");
    await createGa4Refresh({pool,sync}).tick(); assert.equal(calls,4);
  } finally { await db.close(); }
});

test('failures persist, back off, and allow immediate manual retry', async () => {
  const {db,pool}=await fixture(); let fail=true,calls=0;
  const service=createGa4Refresh({pool,sync:async()=>{calls++;if(fail)throw new Error('Access expired');return {written:5};}});
  try {
    await service.tick(); assert.equal((await service.status(1)).state,'error');assert.equal((await service.status(1)).error,'Access expired');
    await service.tick();assert.equal(calls,1);
    fail=false;await service.run(1);assert.equal(calls,2);assert.equal((await service.status(1)).state,'ready');
  } finally {await db.close();}
});

test('duplicate imports are prevented across instances and stale due lists',async()=>{
  const {db,pool}=await fixture();let finish,started,calls=0;
  const began=new Promise(r=>started=r),hold=new Promise(r=>finish=r);
  const sync=async()=>{calls++;started();await hold;return {written:1};};
  const a=createGa4Refresh({pool,sync}),b=createGa4Refresh({pool,sync});
  try {
    await a.enqueue(1);const pending=a.run(1);await began;
    assert.equal((await b.run(1)).skipped,true);finish();await pending;
    assert.equal((await b.run(1,{onlyDue:true})).skipped,true);assert.equal(calls,1);
  }finally{finish?.();await db.close();}
});

test('property change cannot inherit old completion status and disconnect stops scheduling',async()=>{
  const {db,pool}=await fixture();let finish,started,calls=0;
  const began=new Promise(r=>started=r),hold=new Promise(r=>finish=r);
  const service=createGa4Refresh({pool,sync:async()=>{calls++;if(calls===1){started();await hold;throw new Error('Property changed');}return {written:1};}});
  try {
    await service.enqueue(1);const pending=service.run(1);await began;
    await db.exec("UPDATE projects SET ga4_property_id='456' WHERE id=1");
    assert.equal(await service.status(1),null);await service.enqueue(1);
    finish();await assert.rejects(pending,/Property changed/);assert.equal((await service.status(1)).state,'queued');
    await service.tick();assert.equal(calls,2);assert.equal((await service.status(1)).state,'ready');
    await db.exec("UPDATE projects SET ga4_property_id=null WHERE id=1;UPDATE ga4_refresh_state SET next_attempt=now()-interval '1 second'");
    await service.tick();assert.equal(calls,2);assert.equal(await service.status(1),null);
  }finally{finish?.();await db.close();}
});

test('traffic UI distinguishes importing, error, empty successful data and property changes',async()=>{
  const source=fs.readFileSync(new URL('../src/public/app.js',import.meta.url),'utf8');
  const fn=source.slice(source.indexOf('async function viewTraffic()'),source.indexOf('async function loadGa4Properties()'));
  let conn, rows={html:'<p>0 visits</p>'},polls=0;
  const context=vm.createContext({state:{projectId:1,view:'traffic'},api:async url=>url.endsWith('/ga4')?conn:rows,esc:s=>String(s).replaceAll('<','&lt;'),shortDate:s=>s,setTimeout:()=>{polls++;return 1;},render(){}});
  vm.runInContext('let ga4RefreshPoll;'+fn,context);
  conn={connected:true,propertyId:'123',refresh:{state:'running'},syncedAt:null};
  let html=await context.viewTraffic();assert.match(html,/Importing your Analytics data/);assert.match(html,/id="ga4Sync" disabled/);assert.doesNotMatch(html,/0 visits/);assert.equal(polls,1);
  conn.refresh={state:'error',error:'<bad>'};html=await context.viewTraffic();assert.match(html,/>Retry</);assert.match(html,/&lt;bad>/);assert.doesNotMatch(html,/0 visits/);
  conn.syncedAt='2026-10-10';conn.refresh={state:'ready'};html=await context.viewTraffic();assert.match(html,/0 visits/);assert.match(html,/Refresh now/);assert.match(html,/automatically every day/);
  const server=fs.readFileSync(new URL('../src/server.js',import.meta.url),'utf8');
  assert.match(server,/await ga4Refresh.enqueue\(project.id\)/);assert.match(server,/void ga4Refresh.run\(project.id\)/);assert.match(server,/ga4Refresh.start\(\)/);
  assert.match(server,/ga4_synced_at=CASE WHEN ga4_property_id::text IS DISTINCT FROM \$2::text THEN NULL/);
});

test('property endpoint resets stale coverage, starts import and supports changing property',async()=>{
  const {db}=await fixture();const source=fs.readFileSync(new URL('../src/server.js',import.meta.url),'utf8');
  const start=source.indexOf("app.post('/api/projects/:id/ga4/property'");
  const route=source.slice(start,source.indexOf('\n}));',start)+5);
  let handler,queued=[],runs=[];
  const context=vm.createContext({app:{post:(path,auth,fn)=>handler=fn},requireAuth(){},wrap:fn=>fn,
    assertProject:async()=>({id:1}),query:(...args)=>db.query(...args),ga4Refresh:{enqueue:async id=>queued.push(id),run:async id=>runs.push(id)},console});
  vm.runInContext(route,context);
  const invoke=async body=>{let code=200,data;await handler({body},{status(n){code=n;return this;},json(d){data=d;}});return {code,data};};
  try{
    await db.exec("ALTER TABLE projects ADD COLUMN ga4_property_name text;UPDATE projects SET ga4_synced_at=now(),ga4_sync_info='{\"propertyId\":\"123\"}' WHERE id=1");
    assert.equal((await invoke({propertyId:'bad'})).code,400);assert.equal(queued.length,0);
    assert.equal((await invoke({propertyId:'456',propertyName:'New site'})).data.importing,true);
    const p=(await db.query('SELECT * FROM projects WHERE id=1')).rows[0];assert.equal(p.ga4_property_id,'456');assert.equal(p.ga4_synced_at,null);assert.equal(p.ga4_sync_info,null);assert.deepEqual(queued,[1]);assert.deepEqual(runs,[1]);
    assert.equal((await invoke({propertyId:''})).data.importing,false);assert.equal((await db.query('SELECT ga4_property_id FROM projects WHERE id=1')).rows[0].ga4_property_id,null);assert.equal(queued.length,1);
  }finally{await db.close();}
});
