import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../src/public/app.js',import.meta.url),'utf8');
const start=source.indexOf('    const results = d.results || [];');
const chunk=source.slice(start,source.indexOf('\n    return;\n  }',start));
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function render(d){let output;new Function('d','esc','ENGINE_LABEL','finish',chunk)(d,esc,{gemini:'Gemini'},(html,showRead)=>{output={html,showRead};});return output;}
test('failed single-engine request shows error and unchanged measurement, never success or new-answer link',()=>{
 const r=render({results:[{engine:'gemini',ok:false,error:'rate_limit_exceeded'}],spend:0});
 assert.match(r.html,/No new answer was collected/);assert.match(r.html,/rate_limit_exceeded/);assert.match(r.html,/completed measurement is unchanged/);
 assert.equal(r.showRead,false);assert.doesNotMatch(r.html,/Every engine answered|were stored/);
});
test('successful single engine reports one answer and preserved archives',()=>{
 const r=render({results:[{engine:'gemini',ok:true,named:false,replaced:1}],spend:.03});
 assert.match(r.html,/One engine answered/);assert.match(r.html,/did not name you/);assert.match(r.html,/Earlier measurements remain/);assert.match(r.html,/0.0300/);assert.equal(r.showRead,true);
});
test('mixed outcomes stay explicit, and provider error text is escaped',()=>{
 const r=render({results:[{engine:'gemini',ok:false,error:'<script>bad</script>'},{engine:'chatgpt',ok:true,named:true}]});
 assert.match(r.html,/1 engine answered, 1 failed/);assert.match(r.html,/named you/);assert.ok(!r.html.includes('<script>'));assert.equal(r.showRead,true);
});
test('successful empty response remains unmeasured and empty result list is not success',()=>{
 assert.match(render({results:[{engine:'gemini',ok:true,named:null}]}).html,/collected, but not measured/);
 const r=render({results:[]});assert.match(r.html,/No result was returned/);assert.equal(r.showRead,false);
});
