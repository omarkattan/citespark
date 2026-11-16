// One durable alert per project/reason/hour, shared by every web process.
// No raw provider response, prompt, credential or customer email is included.
export function questionFailurePayload({project,userId,stage,error},site) {
 const allowed=['not_configured','http_400','http_401','http_403','http_404','http_429','http_500','http_502','http_503','http_529','timeout','request_failed','truncated_response','invalid_response','insufficient_questions','no_usable_questions','invalid_question_format','branded_questions','language_mismatch'];
 const reason=allowed.includes(error?.reason)?error.reason:'unexpected_error';
 return {kind:'question_preparation_failed',title:'Question preparation failed',subject:`Cited alert: question preparation failed for ${String(project.domain).slice(0,200)}`,
  lead:'A user could not finish preparing questions. Their saved business remains available. Please investigate this project.',
  dedupeKey:`question-preparation:${project.id}:${reason}`,
  rows:[['Website',project.domain],['Project',project.id],['Organisation',project.org_id],['User ID',userId],['Stage',stage],['Reason',reason],['Attempts',Number(error?.attempts)||1],['Reference',`${project.id}/${reason}`]],
  action:'Open project',actionUrl:`${site}/quick-start?site=${project.id}`};
}
export function createQuestionFailureAlert({pool,send,configured,site,logger=console}) {
 return async event=>{
  let client,id;
  try {
   const payload=questionFailurePayload(event,site);
   client=await pool.connect();
   await client.query('BEGIN');
   await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[payload.dedupeKey]);
   const existing=await client.query(`SELECT id FROM notifications WHERE kind='question_preparation_failed' AND detail->>'dedupeKey'=$1 AND ((emailed AND created_at>now()-interval '1 hour') OR (email_error='sending' AND created_at>now()-interval '10 minutes')) LIMIT 1`,[payload.dedupeKey]);
   if(existing.rows.length){await client.query('COMMIT');return {suppressed:true};}
   const inserted=await client.query('INSERT INTO notifications(kind,title,detail,emailed,email_error) VALUES($1,$2,$3,false,$4) RETURNING id',[payload.kind,payload.title,JSON.stringify(payload),configured?'sending':'Email is not configured']);
   id=inserted.rows[0].id;
   await client.query('COMMIT');client.release();client=null;
   if(!configured){logger.error('Question failure alert email is not configured');return {emailed:false};}
   let emailError=null;
   try {await send(payload);}catch{emailError='Email provider failed to accept the alert';logger.error(emailError);}
   await pool.query('UPDATE notifications SET emailed=$2,email_error=$3 WHERE id=$1',[id,!emailError,emailError]);
   return {emailed:!emailError};
  }catch(error){
   if(client)await client.query('ROLLBACK').catch(()=>{});
   logger.error('Question failure alert could not be recorded or sent',error.code||'alert_failed');
   return {emailed:false};
  }finally{client?.release();}
 };
}
