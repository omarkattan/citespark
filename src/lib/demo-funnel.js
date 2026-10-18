import {query} from '../db/index.js';
import {createConversionStore} from './conversion.js';
// Operational milestones only. No IP, email, answer text or third-party analytics.
export async function demoMilestone(req,stage,context=null){
 const store=createConversionStore({query});
 return store.safe(()=>store.milestone(req,stage,context));
}
