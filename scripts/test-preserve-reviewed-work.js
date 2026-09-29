import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {reportReview} from '../src/lib/report-review.js';
const source=readFileSync(new URL('../src/lib/recommend.js',import.meta.url),'utf8');
const body=source.slice(source.indexOf('export async function persistRecommendations(projectId, recs) {')+'export async function persistRecommendations(projectId, recs) {'.length).trim().replace(/\}$/,'');
const persist=new (Object.getPrototypeOf(async function(){}).constructor)('projectId','recs','many','query',body);
test('repeated rebuilds retain saved notes and report snapshots when a question no longer triggers its old rule',async()=>{
 const {PGlite}=await import(process.env.PGLITE_MODULE);const db=new PGlite();
 try{
 await db.exec(readFileSync(new URL('../src/db/schema.sql',import.meta.url),'utf8'));
 await db.exec(`INSERT INTO orgs(id,name) VALUES(1,'Test');INSERT INTO projects(id,org_id,name,domain,brand_name) VALUES(28,1,'Bank','bank.test','Bank'),(99,1,'Other','other.test','Other');
 INSERT INTO recommendations(id,project_id,fingerprint,type,title,action,notes,assignee,due_date,status) VALUES
 (1,28,'old-note','visibility','Saved review','Review','Reviewed page details',NULL,NULL,'open'),
 (2,28,'visibility:2','visibility','Selected report','Review',NULL,NULL,NULL,'open'),
 (3,28,'old-assigned','visibility','Assigned','Review',NULL,'owner@example.test',NULL,'open'),
 (4,28,'old-deadline','visibility','Deadline','Review',NULL,NULL,'2026-10-01','open'),
 (5,28,'old-generated','visibility','Untouched','Review',NULL,NULL,NULL,'open'),
 (6,28,'old-started','visibility','Started','Review',NULL,NULL,NULL,'doing'),
 (7,99,'other-project','visibility','Other project','Review',NULL,NULL,NULL,'open');
 SELECT setval('recommendations_id_seq',100);
 INSERT INTO report_review_notes(recommendation_id,project_id,title,notes) VALUES(2,28,'Client review','Snapshot must survive');`);
 const many=async(sql,args)=>(await db.query(sql,args)).rows;const query=(...args)=>db.query(...args);
 const recs=[{type:'visibility',title:'New rule',action:'Review',evidence:{prompt_id:4},impact:1,effort:1,priority:1}];
 assert.equal((await persist(28,recs,many,query)).withdrawn,1);
 assert.deepEqual((await many('SELECT id FROM recommendations WHERE id<100 ORDER BY id')).map(x=>x.id),[1,2,3,4,6,7]);
 assert.equal((await reportReview(28,null,many)).notes[0].notes,'Snapshot must survive');
 assert.equal((await persist(28,recs,many,query)).withdrawn,0);
 assert.equal((await many('SELECT notes FROM recommendations WHERE id=1'))[0].notes,'Reviewed page details');
 // Existing tasks can receive fresh evidence without replacing client snapshots.
 await persist(28,[{...recs[0],type:'visibility',evidence:{prompt_id:2},title:'Changed title'}],many,query);
 assert.equal((await reportReview(28,null,many)).notes[0].title,'Client review');
 assert.equal((await many('SELECT title FROM recommendations WHERE id=2'))[0].title,'Changed title');
 }finally{await db.close();}
});
