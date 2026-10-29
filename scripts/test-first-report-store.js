import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const {PGlite}=await import(process.env.PGLITE_MODULE);
const db=new PGlite();
await db.exec('CREATE TABLE projects(id integer primary key,org_id integer,setup_step text); INSERT INTO projects VALUES(39,1,\'measurement\'),(40,2,\'sources\');');
const server=readFileSync(new URL('../src/server.js',import.meta.url),'utf8');let route;const auth=()=>{};
const ctx=vm.createContext({app:{post:(path,...handlers)=>route={path,handlers}},requireAuth:auth,wrap:fn=>fn,query:(sql,p)=>db.query(sql,p),measurementLocation:async()=>({ok:false,error:'Location not verified'}),assertProject:async(req,res)=>{const p=(await db.query('SELECT * FROM projects WHERE id=$1 AND org_id=$2',[req.params.id,req.session.orgId])).rows[0];if(!p)res.status(404).json({error:'Not found'});return p;}});
const start=server.indexOf("app.post('/api/projects/:id/setup-progress'");vm.runInContext(server.slice(start,server.indexOf('\n}));',start)+6),ctx);
async function request(step,id=39){const res={code:200,status(code){this.code=code;return this;},json(body){this.body=body;return this;}};await route.handlers.at(-1)({params:{id},session:{orgId:1},body:{step}},res);return res;}
test('recommendations and report progress persist for the owned project without requiring Google',async()=>{
 assert.equal(route.handlers[0],auth);
 for(const step of ['recommendations','report','complete']){assert.equal((await request(step)).code,200);assert.equal((await db.query('SELECT setup_step FROM projects WHERE id=39')).rows[0].setup_step,step);}
 assert.equal((await request('unknown')).code,400);assert.equal((await request('report',40)).code,404);assert.equal((await db.query('SELECT setup_step FROM projects WHERE id=40')).rows[0].setup_step,'sources');
});
test('measurement progress still requires valid measurement configuration',async()=>{assert.equal((await request('measurement')).code,422);assert.equal((await db.query('SELECT setup_step FROM projects WHERE id=39')).rows[0].setup_step,'complete');});
test.after(()=>db.close());
