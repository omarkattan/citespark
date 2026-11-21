import http from 'node:http';
import assert from 'node:assert/strict';
import chromium from '@sparticuz/chromium';
import puppeteer from 'puppeteer-core';
import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs';
import {one,pool} from '../src/db/index.js';
import {buildReport} from '../src/lib/report.js';
import {reportHtml} from '../src/lib/report-html.js';
import {measurementRows} from '../src/lib/measurement-state.js';
import {hasAnswerText} from '../src/lib/answer-quality.js';
import {citationHost,opaqueCitation} from '../src/lib/citation-evidence.js';

http.createServer((req,res)=>{res.writeHead(req.url==='/healthz'?200:404);res.end();}).listen(process.env.PORT || 3000);
let stage='database';
let browser;
try {
  assert.equal((await one('SHOW default_transaction_read_only')).default_transaction_read_only,'on');
  const report=await buildReport(27,{}, {presentationOnly:true});
  const e=report.executive;
  assert.ok(e.measurement?.id);
  const raw=await measurementRows(pool,report.project.id,e.measurement.id);
  const rows=raw.filter(r=>r.ok && hasAnswerText(r.response_text) && r.mentioned!=null);
  const root=report.project.domain.toLowerCase().replace(/^www\./,'');
  const owned=r=>r.citations.some(c=>!opaqueCitation(c.url) && (citationHost(c.url)===root || citationHost(c.url)?.endsWith('.'+root)));
  const groups={all:rows,named:rows.filter(r=>r.mentioned),cited:rows.filter(owned),'cited-unnamed':rows.filter(r=>owned(r)&&!r.mentioned)};
  const counts=Object.fromEntries(Object.entries(groups).map(([k,v])=>[k,v.length]));
  assert.equal(e.totals.measured,counts.all);assert.equal(e.totals.cited,counts.cited);assert.equal(e.totals.named,counts.named);
  console.log('Preview QA reconciled',JSON.stringify({measurement:e.measurement.id,...counts}));
  stage='browser';browser=await puppeteer.launch({args:chromium.args,executablePath:await chromium.executablePath(),headless:true});
  const page=await browser.newPage();
  await page.setRequestInterception(true);page.on('request',r=>r.abort());
  await page.setContent(reportHtml(report),{waitUntil:'domcontentloaded'});
  const ids=rs=>rs.map(r=>String(r.id)).sort();
  for(const [key,group] of Object.entries(groups)){
    await page.click('a[href="#answers-'+key+'"]');
    await page.waitForFunction((n)=>document.querySelector('#answer-evidence-count')?.textContent.startsWith(n+' matching'),{},group.length);
    const visible=await page.$$eval('#answer-evidence-list tbody tr:not([hidden]) td:first-child a',as=>as.map(a=>a.hash.replace('#run-','')).sort());
    assert.deepEqual(visible,ids(group));
  }
  stage='print';await page.emulateMediaType('print');
  assert.equal(await page.$eval('.printed-answer-refs',el=>getComputedStyle(el).display),'block');
  const pdf=await getDocument({data:new Uint8Array(await page.pdf({preferCSSPageSize:true,printBackground:true})),useSystemFonts:true}).promise;
  let appendix=false,clipped=0;const printed=new Set();
  for(let i=1;i<=pdf.numPages;i++){
    const p=await pdf.getPage(i), items=(await p.getTextContent()).items;
    const words=items.map(it=>it.str).join(' ');
    const heading=words.indexOf('Stored answer references');if(heading>=0)appendix=true;
    if(appendix){
      for(const m of words.slice(Math.max(0,heading)).matchAll(/#\s*(\d+)\s*\(/g))printed.add(m[1]);
      for(const it of items)if(it.str?.trim() && (it.transform[4]<-1 || it.transform[4]+it.width>p.view[2]+2))clipped++;
    }
  }
  const expected=ids(rows.filter(r=>r.mentioned||owned(r)));
  console.log('Preview QA print',JSON.stringify({pages:pdf.numPages,expected:expected.length,printed:printed.size,clipped}));
  assert.ok(appendix);assert.deepEqual([...printed].sort(),expected);assert.equal(clipped,0);
  console.log('Preview QA passed');
} catch(error){console.error('Preview QA failed',stage,error.code||error.name,String(error.message).split('\n')[0].slice(0,160));}
finally{await browser?.close();await pool.end();}
