import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {estimateEngineCosts} from '../src/lib/measurement-cost.js';
test('global pin ignores prior mini costs, including similarly named models',()=>{
 const m=estimateEngineCosts(['chatgpt'],{chatgpt:{model:'gpt-4.1'}},{},[{engine:'chatgpt',per:.027}],[{engine:'chatgpt',model:'gpt-4.1-mini',per:.029}]);
 assert.equal(m.get('chatgpt'),.10);
 assert.equal(estimateEngineCosts(['chatgpt'],{chatgpt:{model:'gpt-4.1'}},{},[],[{engine:'chatgpt',model:'gpt-4.1-2025-04-14',per:.072}]).get('chatgpt'),.072);
});
test('project override takes precedence and dated model matching is exact',()=>{
 const costs=estimateEngineCosts(['chatgpt'],{chatgpt:{model:'gpt-4.1'}},{chatgpt:'gpt-4o-mini'},[],[{engine:'chatgpt',model:'gpt-4o-mini-2024-07-18',per:.027},{engine:'chatgpt',model:'gpt-4.1',per:.072}]);
 assert.equal(costs.get('chatgpt'),.027);
});
test('progress distinguishes absent, present, unmeasured and failed answers',()=>{
 const source=readFileSync(new URL('../src/public/app.js',import.meta.url),'utf8');
 const start=source.indexOf('function showProgress('),end=source.indexOf('\n}',start)+2;
 const elements=new Map();const $=id=>{if(!elements.has(id))elements.set(id,{style:{}});return elements.get(id);};
 const c=vm.createContext({$,state:{overview:{cycle:'today'}},PHASE_LABEL:{},ENGINE_LABEL:{},esc:s=>s});
 vm.runInContext(source.slice(start,end),c);
 c.showProgress('asking',4,4,[{state:'answered',named:null,question:'Q',engine:'chatgpt'},{state:'answered',named:false,question:'Q',engine:'chatgpt'},{state:'answered',named:true,question:'Q',engine:'chatgpt'},{state:'failed',question:'Q',engine:'chatgpt'}]);
 const html=$('cycleFeed').innerHTML;
 assert.match(html,/>unmeasured</);assert.match(html,/>not named</);assert.match(html,/>named</);assert.match(html,/>no answer</);
});
