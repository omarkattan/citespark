import { generatePrompts } from './prompts.js';

export function quickStartMutationAllowed(method,path) {
  if (/^\/(?:login|logout|register|password\/(?:forgot|reset)|verify\/resend|product-tour|feedback|billing\/(?:checkout|portal)|demo\/[^/]+)$/.test(path)) return true;
  if(method==='POST' && ['/discover','/projects'].includes(path))return true;
  if(method==='DELETE' && /^\/projects\/\d+$/.test(path))return true;
  return method==='POST' && /^\/projects\/\d+\/(?:run|quick-start\/(?:questions|suggestions|profile))$/.test(path);
}
export function validateQuickQuestions(items) {
  if(!Array.isArray(items)||items.length!==20)throw new Error('Keep exactly 20 questions for your initial report.');
  const texts=items.map(v=>typeof v==='string'?v.trim():'');
  if(texts.some(v=>v.length<12||v.length>500))throw new Error('Each question must contain 12 to 500 characters.');
  if(new Set(texts.map(v=>v.normalize('NFKC').toLowerCase().replace(/[?؟.!\s]+$/gu,''))).size!==20)throw new Error('Replace duplicate questions with distinct buying situations.');
  return texts;
}
export function mountQuickStart(app,{requireAuth,assertProject,getEntitlements,query,one,many,pool,generate=generatePrompts}) {
 const wrap=fn=>(req,res,next)=>Promise.resolve(fn(req,res)).catch(next);
 app.get('/api/projects/:id/quick-start',requireAuth,wrap(async(req,res)=>{
  const project=await assertProject(req,res);if(!project)return;
  const [billing,questions,claim]=await Promise.all([
    getEntitlements(req.session.orgId),
    many('SELECT id,text FROM prompts WHERE project_id=$1 AND active ORDER BY id',[project.id]),
    one('SELECT * FROM quick_start_reports WHERE org_id=$1',[req.session.orgId])
  ]);
  const measurement=await one("SELECT id,status,started_at,completed_at FROM measurement_batches WHERE project_id=$1 ORDER BY id DESC LIMIT 1",[project.id]);
  res.json({project,questions,billing,claim,measurement});
 }));
 app.post('/api/projects/:id/quick-start/profile',requireAuth,wrap(async(req,res)=>{
  const project=await assertProject(req,res);if(!project)return;
  if(!project.quick_start)return res.status(400).json({error:'Use site settings for this existing project.'});
  const brand=String(req.body.brandName||'').trim(),category=String(req.body.category||'').trim();
  const market=String(req.body.market||project.market).toUpperCase(),language=req.body.language||project.language;
  const location=String(req.body.locationName??project.location_name??'').trim().slice(0,200);
  const qualifier=String(req.body.qualifier||'').trim().slice(0,1500);
  if(!brand||brand.length>150||!category||category.length>500||!/^[A-Z]{2}$/.test(market)||!['en','ar'].includes(language))return res.status(422).json({error:'Check your business name, services, market and question language.'});
  const used=await one('SELECT 1 FROM quick_start_reports WHERE project_id=$1',[project.id]);
  const history=await one('SELECT 1 FROM runs WHERE project_id=$1 LIMIT 1',[project.id]);
  if(used||history)return res.status(409).json({error:'Your report has started. Business details cannot change during this scan.'});
  // Prepare a replacement first. Failed generation never erases the usable set.
  let suggestions;
  try {
   suggestions=await generate({brand,domain:project.domain,category,market:location||new Intl.DisplayNames(['en'],{type:'region'}).of(market),qualifier,language,count:20,quickStart:true});
   validateQuickQuestions(suggestions.map(p=>p.text));
  } catch { return res.status(503).json({error:'We could not finish updating your questions. Your previous details are saved. Please try again.'}); }
  const client=await pool.connect();
  try {
   await client.query('BEGIN');
   const lock=await client.query('SELECT pg_try_advisory_xact_lock(290029,$1) AS locked',[project.id]);
   const started=await client.query('SELECT 1 FROM runs WHERE project_id=$1 UNION ALL SELECT 1 FROM quick_start_reports WHERE project_id=$1 LIMIT 1',[project.id]);
   if(!lock.rows[0].locked||started.rowCount)throw new Error('Your report has started. Your details have not been changed.');
   await client.query('UPDATE projects SET name=$2,brand_name=$2,category=$3,qualifier=$4,market=$5,language=$6,location_name=$7 WHERE id=$1',[project.id,brand,category,qualifier,market,language,location||null]);
   await client.query("UPDATE entities SET name=$2 WHERE project_id=$1 AND kind='owned'",[project.id,brand]);
   await client.query('UPDATE prompts SET active=false WHERE project_id=$1',[project.id]);
   for(const p of suggestions)await client.query("INSERT INTO prompts(project_id,text,cluster,intent) VALUES($1,$2,$3,$4) ON CONFLICT(project_id,text) DO UPDATE SET active=true,cluster=EXCLUDED.cluster,intent=EXCLUDED.intent",[project.id,p.text,p.cluster,p.intent]);
   await client.query('COMMIT');res.json({ok:true});
  }catch(e){await client.query('ROLLBACK');res.status(409).json({error:e.message});}finally{client.release();}
 }));
 app.post('/api/projects/:id/quick-start/questions',requireAuth,wrap(async(req,res)=>{
  const project=await assertProject(req,res);if(!project)return;
  if(!project.quick_start)return res.status(400).json({error:'Use question management for this existing project.'});
  let texts;try{texts=validateQuickQuestions(req.body.questions);}catch(e){return res.status(422).json({error:e.message});}
  const client=await pool.connect();
  try {
   await client.query('BEGIN');
   const locked=await client.query('SELECT pg_try_advisory_xact_lock(290029,$1) AS locked',[project.id]);
   if(!locked.rows[0].locked)throw new Error('A scan is already running. Your questions have not been changed.');
   const history=await client.query('SELECT 1 FROM runs WHERE project_id=$1 LIMIT 1',[project.id]);
   const claim=await client.query('SELECT 1 FROM quick_start_reports WHERE project_id=$1',[project.id]);
   if(history.rowCount||claim.rowCount)throw new Error('Your report questions are already saved. Upgrade to manage questions for future scans.');
   // Before the first measurement only. Keep identifiers and metadata for unchanged suggestions.
   const current=(await client.query('SELECT id,text FROM prompts WHERE project_id=$1 AND active ORDER BY id',[project.id])).rows;
   for(const row of current)if(!texts.includes(row.text))await client.query('UPDATE prompts SET active=false WHERE id=$1',[row.id]);
   for(const text of texts)await client.query("INSERT INTO prompts(project_id,text,cluster,intent,source) VALUES($1,$2,'quick-start','commercial','custom') ON CONFLICT(project_id,text) DO UPDATE SET active=true",[project.id,text]);
   await client.query('COMMIT');res.json({ok:true});
  } catch(e){await client.query('ROLLBACK');res.status(409).json({error:e.message});}finally{client.release();}
 }));
 app.post('/api/projects/:id/quick-start/suggestions',requireAuth,wrap(async(req,res)=>{
  const project=await assertProject(req,res);if(!project)return;
  const existing=await many('SELECT text FROM prompts WHERE project_id=$1 AND active',[project.id]);
  const used=await one('SELECT 1 FROM quick_start_reports WHERE org_id=$1',[req.session.orgId]);
  if(used||!project.quick_start||existing.length>=20)return res.status(409).json({error:'Review your saved questions. Additional suggestions are only needed for an incomplete initial set.'});
  let suggestions;
  try { suggestions=await generate({brand:project.brand_name,domain:project.domain,category:project.category,market:project.location_name||new Intl.DisplayNames(['en'],{type:'region'}).of(project.market),qualifier:project.qualifier,language:project.language,count:20,quickStart:true}); }
  catch(e){return res.status(503).json({error:/Buyer-shortlist/.test(e.message)?'We could not prepare enough buyer-shortlist questions. Please try again. Your business is saved.':'Question preparation is temporarily unavailable. Please try again. Your business is saved.'});}
  const key=text=>text.normalize('NFKC').toLowerCase().replace(/[?؟.!\s]+$/gu,'');
  const seen=new Set(existing.map(p=>key(p.text)));
  const fresh=suggestions.filter(p=>{const k=key(p.text);if(seen.has(k))return false;seen.add(k);return true;});
  // Return suggestions for review. Saving them is an explicit separate action.
  res.json({questions:[...existing.map(p=>p.text),...fresh.map(p=>p.text)].slice(0,20)});
 }));
}
