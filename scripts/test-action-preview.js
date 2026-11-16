import test from 'node:test';
import assert from 'node:assert/strict';
import {previewActions} from '../src/lib/action-preview.js';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {schemaUpgrades} from '../src/db/upgrades.js';
test('free API preview allowlists titles and never leaks implementation or source details',()=>{
 const rows=[{id:1,title:'Review service clarity',action:'PRIVATE COPY',evidence:{secret:'PRIVATE',action_plan:{title:'Service clarity',position:1,change:'PRIVATE COPY',rationale:'PRIVATE',page:'https://private.example',evidence:{observation:'PRIVATE'},generation:'page-grounded'}}}];
 const result=previewActions(rows);assert.equal(result[0].evidence.action_plan.title,'Service clarity');assert.doesNotMatch(JSON.stringify(result),/PRIVATE|private.example/);assert.equal(rows[0].action,'PRIVATE COPY');
});
test('new cohort schema upgrade preserves existing accounts and matches the complete schema',()=>{
 const upgrade=schemaUpgrades.at(-1);const schema=readFileSync(new URL('../src/db/schema.sql',import.meta.url),'utf8');assert.equal(upgrade.to,createHash('sha256').update(schema).digest('hex'));assert.match(upgrade.steps[0].sql,/ADD COLUMN IF NOT EXISTS quick_start_action_preview BOOLEAN NOT NULL DEFAULT false/);assert.match(upgrade.steps[0].sql,/SET DEFAULT true/);
});
