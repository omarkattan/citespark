import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {evaluateRules} from '../src/lib/recommend.js';
const app=readFileSync(new URL('../src/public/app.js',import.meta.url),'utf8');
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function harness(){
 const h=vm.createContext({esc,state:{overview:{}},dueLabel:()=>'',evidenceDetails:()=>'',highlight:esc});
 vm.runInContext("const STATUS_LABEL={open:'To do'};"+app.slice(app.indexOf('const TYPE_LABEL'),app.indexOf('/**\n * Who is doing')),h);
 return h;
}
const types=['citable_asset','entity_authority','ordinal_push','engine_gap','sentiment_correction','fanout_target','decline_alert','replicate_winner','named_not_cited'];
for(const type of types) test(`legacy ${type} card replaces unsupported claims without changing evidence or actions`,()=>{
 const task={id:3,type,title:'UNSUPPORTED_OLD_TITLE',action:'UNSUPPORTED_OLD_ADVICE',status:'open',priority:30,effort:2,notes:'Keep this',evidence:{prompt_id:7,prompt:'Buyer <question>',own_rate:null,snippet:'Stored quotation'}};
 const before=JSON.stringify(task);const html=harness().taskCard(task,true);
 assert.doesNotMatch(html,/UNSUPPORTED_OLD|you null%|you 0%/);assert.match(html,/Observed/);assert.match(html,/Check next/);assert.match(html,/Action supported now/);assert.match(html,/Buyer &lt;question&gt;/);assert.match(html,/Keep this/);assert.match(html,/data-status="doing"/);assert.match(html,/data-see-answer="7"/);assert.equal(JSON.stringify(task),before);
});
test('trend and referral reviews lead to their evidence surfaces',()=>{
 const h=harness();for(const [type,view] of [['decline_alert','trends'],['replicate_winner','traffic']])assert.match(h.taskCard({id:1,type,status:'open',evidence:{}}),new RegExp(`data-open-view="${view}"`));
});
const project={domain:'example.com',brand_name:'Example'};
const stat=o=>({prompt_id:1,text:'Which supplier?',cluster:'buyer',ai_search_volume:100,engine:'chatgpt',entity_id:1,name:'Example',kind:'owned',domain:'example.com',runs:3,hits:0,avg_ordinal:null,negatives:0,snippet:null,sample_run:10,...o});
const cases=[
 {stats:[stat({hits:3})]},
 {stats:[stat({hits:0})],ownCitedByPrompt:new Map([[1,2]])},
 {stats:[stat({hits:3,avg_ordinal:4})],ownCitedByPrompt:new Map([[1,2]])},
 {stats:[stat({hits:3}),stat({engine:'perplexity',hits:0})],ownCitedByPrompt:new Map([[1,2]])},
 {stats:[stat({hits:2,negatives:1,snippet:'Review this'})],ownCitedByPrompt:new Map([[1,2]])},
 {stats:[stat({hits:1})],ownCitedByPrompt:new Map([[1,2]]),fanOutByPrompt:new Map([[1,[{query:'supplier query',n:2}] ]])},
 {stats:[stat({hits:0})],priorRates:new Map([[1,0.9]])},
 {stats:[stat({hits:3})],ownCitedByPrompt:new Map([[1,2]]),ga4:[{landing_page:'/a',sessions:100,conversions:20,revenue:30},{landing_page:'/b',sessions:400,conversions:8,revenue:10}]}
];
const signature=rows=>rows.map(({title,action,...rest})=>rest);

const expected=[[{"type":"citable_asset","target_url":null,"impact":80,"effort":3,"priority":26.67,"evidence":{"prompt_id":1,"prompt":"Which supplier?","own_rate":100,"citations":0,"took_the_citation":[],"url":null,"question":"Which supplier?","analysable":false}}],[{"type":"content_gap","target_url":null,"impact":100,"effort":4,"priority":25,"evidence":{"prompt_id":1,"prompt":"Which supplier?","runs":3,"own_rate":0,"cluster":"buyer"}},{"type":"entity_authority","target_url":null,"impact":70,"effort":3,"priority":23.33,"evidence":{"prompt_id":1,"prompt":"Which supplier?","own_rate":0,"citations":2}}],[{"type":"ordinal_push","target_url":null,"impact":40,"effort":2,"priority":20,"evidence":{"prompt_id":1,"prompt":"Which supplier?","avg_ordinal":4}}],[{"type":"engine_gap","target_url":null,"impact":45,"effort":2,"priority":22.5,"evidence":{"prompt_id":1,"prompt":"Which supplier?","best":"chatgpt","worst":"perplexity"}}],[{"type":"sentiment_correction","target_url":null,"impact":90,"effort":3,"priority":30,"evidence":{"prompt_id":1,"prompt":"Which supplier?","snippet":"Review this","run_id":10}}],[{"type":"entity_authority","target_url":null,"impact":70,"effort":3,"priority":23.33,"evidence":{"prompt_id":1,"prompt":"Which supplier?","own_rate":33,"citations":2}},{"type":"fanout_target","target_url":null,"impact":50,"effort":3,"priority":16.67,"evidence":{"prompt_id":1,"prompt":"Which supplier?","queries":["supplier query"],"own_rate":33}}],[{"type":"decline_alert","target_url":null,"impact":108,"effort":1,"priority":108,"evidence":{"prompt_id":1,"prompt":"Which supplier?","before":90,"now":0}},{"type":"content_gap","target_url":null,"impact":100,"effort":4,"priority":25,"evidence":{"prompt_id":1,"prompt":"Which supplier?","runs":3,"own_rate":0,"cluster":"buyer"}}],[{"type":"replicate_winner","target_url":"/a","impact":100,"effort":2,"priority":50,"evidence":{"sessions":100,"conversions":20,"revenue":30}}]];
test('wording changes preserve trigger outputs, evidence, scores, targets and ordering across eight rule scenarios',()=>{
 cases.forEach((c,i)=>assert.deepEqual(JSON.parse(JSON.stringify(signature(evaluateRules({project,...c})))),expected[i]));
});
