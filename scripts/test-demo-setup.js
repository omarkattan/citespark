import test from 'node:test';
import assert from 'node:assert/strict';
import {selectedDemoQuestions} from '../src/lib/demo-setup.js';
test('preserves wording and removes exact duplicates without importing measurements',()=>{
 const q='Which agency suits my business?';assert.deepEqual(selectedDemoQuestions([q,q,'  A different buying question?  ']),[q,'A different buying question?']);assert.deepEqual(selectedDemoQuestions(null),[]);
});
test('rejects invalid question lists before project creation',()=>{
 for(const v of ['text',[null],['short'],['a'.repeat(501)],Array(11).fill('Which agency suits my business?')])assert.throws(()=>selectedDemoQuestions(v));
});
