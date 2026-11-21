import {test} from 'node:test';
import assert from 'node:assert/strict';
import {summariseEvidence} from '../src/lib/report-evidence.js';
import {reportHtml} from '../src/lib/report-html.js';

test('report and work-queue hash select exact measured rows and retain answer references',async()=>{
  const {JSDOM}=await import(process.env.JSDOM_MODULE || 'jsdom');
  const row={prompt_id:7,text:'Which wealth managers serve Dubai?',engine:'chatgpt',ok:true,mentioned:false,cited:true,response_text:'A retained answer.',collected:'2026-11-08',source_links:[{owned:true,url:'https://example.org/page'}]};
  const e=summariseEvidence([ {...row,id:1,prompt_id:8,text:'What is asset management?'},
    {...row,id:2,peer_ids:['5']},{...row,id:3,mentioned:true,cited:false,source_links:[]},
    {...row,id:4,mentioned:null},{...row,id:5,ok:false},{...row,id:6,response_text:''} ]);
  e.measurement={id:12,started_at:'2026-11-08T12:00:00Z',settings:{market:'UAE',entities:[{id:5,kind:'competitor',name:'Tracked firm'}]}};
  const r={executive:e,project:{id:9,name:'Example',domain:'example.org'},generatedAt:'2026-11-21',trend:{points:[]},sources:{sources:[]},persistence:{items:[]},methodNotes:[],caveats:[]};
  const url='https://example.org/api/projects/9/report';
  const dom=new JSDOM(reportHtml(r),{url:url+'#answers-cited-unnamed',runScripts:'dangerously',beforeParse(w){w.HTMLElement.prototype.scrollIntoView=()=>{};}});
  try {
    const {document}=dom.window;
    const visible=()=>Array.from(document.querySelectorAll('#answer-evidence-list tbody tr')).filter(tr=>!tr.hidden);
    assert.equal(visible().length,2);
    assert.match(visible()[0].textContent,/Answer #2.*Tracked firm/);
    assert.match(visible()[1].textContent,/Answer #1/);
    assert.equal(visible()[0].querySelector('a').href,'https://example.org/api/projects/9/measurements/12#run-2');
    assert.equal(visible()[0].lastElementChild.querySelector('a').href,'https://example.org/page');
    const click=async hash=>{
      const changed=new Promise(resolve=>dom.window.addEventListener('hashchange',resolve,{once:true}));
      document.querySelector('a[href="'+hash+'"]').click();
      await changed;
    };
    await click('#answers-named-q7');
    assert.equal(visible().length,1);assert.match(visible()[0].textContent,/Answer #3/);
    await click('#answers-named-q8');
    assert.equal(visible().length,0);assert.match(document.querySelector('[role=status]#answer-evidence-count').textContent,/0 matching/);
    await click('#answers-all');assert.equal(visible().length,e.totals.measured);
    assert.equal(document.querySelector('#answer-evidence-list').open,true);
    const old={...r,executive:{...e,answers:undefined}};
    assert.doesNotMatch(reportHtml(old),/href="#answers-named"/);
  } finally {dom.window.close();}
});
