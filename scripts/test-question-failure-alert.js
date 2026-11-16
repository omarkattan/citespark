import test from 'node:test';
import assert from 'node:assert/strict';
import {createQuestionFailureAlert,questionFailurePayload} from '../src/lib/question-failure-alert.js';
const event={project:{id:147,org_id:86,domain:'example.com'},userId:5,stage:'Prepare Quick Start questions',error:{reason:'timeout',attempts:2,message:'PRIVATE PROVIDER BODY'}};
function fixture({duplicate=false,sendFails=false,dbFails=false,configured=true}={}){
 const calls=[];let sent=0,released=0;
 const query=async(sql,args)=>{calls.push({sql,args});if(dbFails)throw new Error('database');if(sql.startsWith('SELECT id'))return {rows:duplicate?[{id:1}]:[]};if(sql.startsWith('INSERT'))return {rows:[{id:7}]};return {rows:[]};};
 const alert=createQuestionFailureAlert({pool:{connect:async()=>({query,release:()=>released++}),query},send:async()=>{sent++;if(sendFails)throw new Error('secret response')},configured,site:'https://cited.ae',logger:{error(){}}});
 return {alert,calls,get sent(){return sent},get released(){return released}};
}
test('emails after durable log and records delivery',async()=>{const f=fixture();assert.deepEqual(await f.alert(event),{emailed:true});assert.equal(f.sent,1);assert.equal(f.released,1);assert.deepEqual(f.calls.at(-1).args,[7,true,null]);assert.ok(f.calls.some(c=>c.sql.includes('pg_advisory_xact_lock')));});
test('duplicate project/reason does not send or insert',async()=>{const f=fixture({duplicate:true});assert.deepEqual(await f.alert(event),{suppressed:true});assert.equal(f.sent,0);assert.ok(!f.calls.some(c=>c.sql.startsWith('INSERT')));});
test('send failure is logged and not marked delivered',async()=>{const f=fixture({sendFails:true});assert.deepEqual(await f.alert(event),{emailed:false});assert.equal(f.calls.at(-1).args[1],false);assert.doesNotMatch(JSON.stringify(f.calls),/secret response/);});
test('database failure never breaks customer request',async()=>{const f=fixture({dbFails:true});assert.deepEqual(await f.alert(event),{emailed:false});assert.equal(f.sent,0);assert.equal(f.released,1);});
test('missing email config remains explicitly logged',async()=>{const f=fixture({configured:false});assert.deepEqual(await f.alert(event),{emailed:false});assert.equal(f.sent,0);assert.equal(f.calls.find(c=>c.sql.startsWith('INSERT')).args[3],'Email is not configured');});
test('safe payload is scoped per project/reason and omits raw errors',()=>{const p=questionFailurePayload(event,'https://cited.ae');assert.equal(p.dedupeKey,'question-preparation:147:timeout');assert.doesNotMatch(JSON.stringify(p),/PRIVATE/);assert.equal(questionFailurePayload({...event,error:{reason:'secret'}},'https://cited.ae').dedupeKey,'question-preparation:147:unexpected_error');});
