import test from 'node:test';
import assert from 'node:assert/strict';
import {validateDecision,decisionReportText} from '../src/lib/recommendation-decision.js';
import {selectedReportAction} from '../src/lib/report-executive-html.js';
import {reportNotePreview} from '../src/lib/report-note.js';
const base={stage:'ready',page:'https://bank.example/app',evidence:'Two stored answers.',change:'Link to the existing hub.',purpose:'Help customers compare.',suggested_owner:'Content team',completion:'EN and AR links work on mobile.',follow_up:'Repeat the same question and settings.',reviewed_at:'2026-09-30'};
test('optional fields validate with no forced rewrite of legacy decisions',()=>{
 const d=validateDecision(base);assert.equal(d.completion,base.completion);
 for(const key of ['purpose','suggested_owner','completion','follow_up']) {
  assert.throws(()=>validateDecision({...base,[key]:['wrong']}));assert.throws(()=>validateDecision({...base,[key]:'x'.repeat(1501)}));
 }
 assert.equal(validateDecision({stage:'ready',page:base.page,evidence:base.evidence,change:base.change}).purpose,undefined);
});
test('report copies preserve delivery details and detect edits without altering saved text',()=>{
 const rec={id:1,project_id:28,title:'Link options',review_decision:base};const p=reportNotePreview(rec);
 assert.match(p.proposed.notes,/Suggested owner \(not an assignment\): Content team/);
 const changed=reportNotePreview({...rec,review_decision:{...base,completion:'Updated check'}},p.proposed);assert.equal(changed.changed,true);assert.match(changed.current.notes,/EN and AR links/);
});
test('structured selected cards render safe fields and fall back to exact legacy text',()=>{
 const n={notes:decisionReportText(base).trim(),decision_snapshot:base};const html=selectedReportAction(n);
 assert.match(html,/<dt>Completion checks<\/dt>/);assert.match(html,/href="https:\/\/bank.example\/app"/);assert.match(html,/not an assignment/);
 assert.match(selectedReportAction({...n,notes:'Legacy text'}),/Legacy text/);assert.doesNotMatch(selectedReportAction({...n,notes:'Legacy text'}),/Help customers/);
 const unsafe={...base,purpose:'<script>alert(1)</script>'};assert.doesNotMatch(selectedReportAction({notes:decisionReportText(unsafe).trim(),decision_snapshot:unsafe}),/<script>/);
});
test('snapshot migration is repeatable and preserves existing selected notes',async()=>{
 const {PGlite}=await import(process.env.PGLITE_MODULE);const db=new PGlite();
 try{await db.exec("CREATE TABLE report_review_notes(notes text); INSERT INTO report_review_notes VALUES('Existing selected copy');");
 const migration='ALTER TABLE report_review_notes ADD COLUMN IF NOT EXISTS decision_snapshot JSONB';await db.exec(migration);await db.exec(migration);
 assert.deepEqual((await db.query('SELECT * FROM report_review_notes')).rows,[{notes:'Existing selected copy',decision_snapshot:null}]);
 }finally{await db.close();}
});
