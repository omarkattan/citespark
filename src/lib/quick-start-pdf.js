import {fileURLToPath} from 'node:url';
import PDFDocument from 'pdfkit';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const font=require.resolve('dejavu-fonts-ttf/ttf/DejaVuSans.ttf');
const bold=require.resolve('dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf');
const text=v=>String(v??'').replace(/[\x00-\x08\x0b-\x1f]/g,'');
// Shape Arabic as a whole line so PDFKit does not reorder words independently.
const textOptions=value=>/\p{Script=Arabic}/u.test(value)?{align:'right',features:['liga']}:{};
const rate=(n,d)=>d>0?`${Math.round(n/d*100)}%`:'Not measured';

export async function quickStartPdf(project,evidence,actions=[]){
 const doc=new PDFDocument({size:'A4',margin:48,bufferPages:true,info:{Title:`${text(project.brand_name||project.name)} - Cited Quick Start report`,Author:'Cited'}});
 const chunks=[];const ready=new Promise((resolve,reject)=>{doc.on('data',c=>chunks.push(c));doc.on('end',()=>resolve(Buffer.concat(chunks)));doc.on('error',reject);});
 doc.registerFont('body',font);doc.registerFont('bold',bold);doc.font('body');
 const room=h=>{if(doc.y+h>doc.page.height-65)doc.addPage();};
 const para=(value,size=10,color='#243d32')=>{doc.font('body').fontSize(size).fillColor(color).text(text(value),{lineGap:4});doc.moveDown(.5);};
 const heading=value=>{room(64);doc.font('bold').fontSize(17).fillColor('#087647').text(value);doc.moveDown(.5);};
 doc.image(fileURLToPath(new URL('../public/cited-logo.jpeg',import.meta.url)),48,48,{width:240});doc.y=130;
 para('QUICK START REPORT',10);doc.moveDown();
 doc.font('bold').fontSize(24).fillColor('#10271f').text(text(project.brand_name||project.name));
 para(project.domain);para(`Measurement: ${evidence.cycle?new Date(evidence.cycle).toISOString().slice(0,10):'Not available'} | Downloaded: ${new Date().toISOString().slice(0,10)}`);
 const market=evidence.measurement?.settings?.market||project.market;
 if(market)para('Configured market: '+(/^[A-Z]{2}$/.test(market)?new Intl.DisplayNames(['en'],{type:'region'}).of(market):market)+'. Places named in questions may differ.');
 const langs=[...new Set(evidence.questions.map(q=>/[\u0600-\u06ff]/.test(q.text)?'Arabic':'English'))];
 if(langs.length)para('Question languages: '+langs.join(' and '));
 const t=evidence.totals;
 heading('Your AI visibility snapshot');
 para(`Brand named: ${rate(t.named,t.measured)} (${t.named} of ${t.measured} measured answers)`,13);
 para(`Website cited: ${rate(t.cited,t.measured)} (${t.cited} of ${t.measured} measured answers)`,13);
 para(`${evidence.questions.length} questions in this sample. Naming and citations overlap. This is a snapshot of collected answers, not overall market visibility.`);
 para(`Coverage: ${t.failed} failed checks, ${t.unmeasured} unmeasured answers, ${t.missingChecks??'unknown'} missing checks. ${t.possiblyTruncated} measured answers may be truncated.`);
 for(const warning of evidence.localeWarnings||[])para(warning,10,'#885010');
 heading('Results by AI engine');
 for(const e of evidence.engineCoverage||[])para(`${e.engine}: named in ${e.named}/${e.measured}; website cited in ${e.cited}/${e.measured} measured answers.`);
 heading(project.actionPreview?'Your opportunity preview':'Three things to look at next');
 if(project.actionPreview)para('Upgrade for the detailed action plan and ongoing monitoring. Suggested opportunities need review, and do not guarantee AI recommendations.');
 if(!actions.length)para('No suggested actions are available yet. Return to your saved report to check for updates.');
 for(const [i,row] of actions.slice(0,3).entries()){
  const p=row.evidence.action_plan;room(project.actionPreview?55:100);
  doc.font('bold').fontSize(12).fillColor('#10271f').text(`${i+1}. ${text(p.title||row.title)}`,textOptions(p.title||row.title));doc.moveDown(.4);
  if(p.generation!=='page-grounded')para('Website verification is incomplete. Treat this as a suggested check, not a confirmed content gap.',9,'#885010');
  if(!project.actionPreview){para(p.change||row.action);if(p.rationale)para(p.rationale);if(p.page)para(p.page,9);}
 }
 heading('Question results');
 para('Counts below use measured answers only. Missing or failed answers are not scored as absence.');
 for(const [i,q] of evidence.questions.entries()){
  room(78);doc.font('bold').fontSize(11).fillColor('#10271f').text(`${i+1}. ${text(q.text)}`,{lineGap:3,...textOptions(q.text)});doc.moveDown(.4);
  const flagged=(evidence.answers||[]).filter(a=>a.questionId===q.id&&a.offTopic);
  if(flagged.length)para('Flagged as off-topic by reviewer: '+flagged.map(a=>a.engine).join(', ')+'. Original measurements retained.',9);
  para(`Named: ${q.named}/${q.measured} | Cited: ${q.cited}/${q.measured} | Failed: ${q.failed} | Unmeasured: ${q.unmeasured}`,9);
 }
 heading('Supporting evidence');
 para('Open your saved Cited report to inspect the original answers and cited sources. Sign-in is required. Downloading this PDF does not run a new scan.');
 const url=`https://cited.ae/quick-start?site=${encodeURIComponent(project.id)}`;
 doc.fillColor('#087647').fontSize(10).text(url,{link:url});
 const range=doc.bufferedPageRange();
 for(let n=0;n<range.count;n++){doc.switchToPage(n);doc.font('body').fontSize(8).fillColor('#52665b').text(`Cited | ${n+1} / ${range.count}`,48,doc.page.height-40,{lineBreak:false});}
 doc.end();return ready;
}
