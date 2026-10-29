import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {ownPageUrl,pageMatch} from '../src/lib/action-pages.js';
const {PGlite}=await import(process.env.PGLITE_MODULE);
const db=new PGlite();let generations=0;
await db.exec(`CREATE TABLE entities(id integer,project_id integer,kind text);
CREATE TABLE prompts(id integer,text text);
CREATE TABLE reporting_runs(id integer,prompt_id integer,project_id integer,engine text,response_text text,measurement_id integer,cycle_date timestamptz,ok boolean);
CREATE TABLE mentions(run_id integer,entity_id integer,mentioned boolean);
CREATE TABLE recommendations(id serial primary key,project_id integer,fingerprint text,type text,title text,action text,target_url text,impact numeric,effort numeric,priority numeric,evidence jsonb,updated_at timestamptz,status text default 'open',review_decision jsonb default '{}',notes text,assignee text,due_date date,unique(project_id,fingerprint));
CREATE TABLE recommendation_suppressions(project_id integer,fingerprint text);
CREATE TABLE recommendation_history(project_id integer,cycle_date date,fingerprint text,type text,title text,target_url text,priority numeric,evidence jsonb,unique(project_id,cycle_date,fingerprint));
CREATE TABLE report_review_notes(recommendation_id integer,project_id integer,notes text);
INSERT INTO entities VALUES(1,39,'owned'),(2,40,'owned');
INSERT INTO prompts VALUES(1,'How much does this routine cost?'),(2,'Which serum is best?'),(3,'How do these options compare?'),(4,'Which competitor is best?');
INSERT INTO reporting_runs SELECT i,i,CASE WHEN i=4 THEN 40 ELSE 39 END,'chatgpt','A saved answer with factual details for checking.',60,'2026-10-29',true FROM generate_series(1,4) i;
INSERT INTO mentions SELECT i,CASE WHEN i=4 THEN 2 ELSE 1 END,false FROM generate_series(1,4) i;
INSERT INTO recommendations(project_id,fingerprint,type,title,action,evidence,review_decision,notes,assignee) VALUES(39,'content_gap:1','content_gap','Existing title','Original guidance','{"prompt_id":1}','{"stage":"ready","change":"Approved human edit"}','Human notes','content owner');
INSERT INTO report_review_notes VALUES(1,39,'Fixed report copy');`);
const ctx=vm.createContext({many:async(sql,p)=>(await db.query(sql,p)).rows,query:(sql,p)=>db.query(sql,p),ownPageUrl,pageMatch,console,
 readActionPages:async()=>[{id:'page-1',url:'https://example.org/products/serum',title:'Routine serum cost',text:'Our routine serum comes in a labelled pack with clear usage instructions.',read_at:'2026-10-29'}],
 complete:async()=>{generations++;return '[]';},recordedCompletion:async()=>{generations++;return '[]';},parseJsonArray:JSON.parse});
const source=readFileSync(new URL('../src/lib/immediate-actions.js',import.meta.url),'utf8').replace(/^import .*;\n/gm,'').replace(/export /g,'');vm.runInContext(source,ctx);
const recSource=readFileSync(new URL('../src/lib/recommend.js',import.meta.url),'utf8');vm.runInContext(recSource.slice(recSource.indexOf('export async function persistRecommendations')).replace('export ',''),ctx);
const project={id:39,domain:'example.org',name:'Example'},cycle=new Date('2026-10-29');
const recs=()=>[1,2,3].map(id=>({type:'content_gap',title:'Review answer',action:'The brand was not named.',target_url:null,impact:10,effort:3,priority:3,evidence:{prompt_id:id,prompt:['How much does this routine cost?','Which serum is best?','How do these options compare?'][id-1]}}));
test('stored measurement creates three actions, preserves human work and report copies, and reuses cached plans',async()=>{
 const first=await ctx.attachImmediateActions(project,recs(),cycle);assert.equal(first.filter(r=>r.evidence.action_plan).length,3);assert.ok(first.every(r=>r.evidence.action_plan.evidence.answer_id!==4));await ctx.persistRecommendations(39,first);
 const saved=(await db.query('SELECT * FROM recommendations WHERE id=1')).rows[0];assert.equal(saved.review_decision.change,'Approved human edit');assert.equal(saved.notes,'Human notes');assert.equal(saved.assignee,'content owner');assert.equal((await db.query('SELECT notes FROM report_review_notes')).rows[0].notes,'Fixed report copy');
 await ctx.attachImmediateActions(project,recs(),cycle);assert.equal(generations,1);
});
test('dismissed, no-change and suppressed actions are not regenerated as suggested next actions',async()=>{
 await db.exec(`UPDATE recommendations SET status='dismissed' WHERE fingerprint='content_gap:1';UPDATE recommendations SET review_decision='{"stage":"no_change"}' WHERE fingerprint='content_gap:2';INSERT INTO recommendation_suppressions VALUES(39,'content_gap:3');`);
 const rows=await ctx.attachImmediateActions(project,recs(),cycle);assert.equal(rows.filter(r=>r.evidence.action_plan).length,0);assert.equal(generations,1);
});
test.after(()=>db.close());
