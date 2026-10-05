export function selectedDemoQuestions(value){
 if(value==null)return [];
 if(!Array.isArray(value)||value.length>10)throw Error('Choose up to ten demo questions.');
 const texts=value.map(v=>{if(typeof v!=='string'||v.trim().length<10||v.trim().length>500)throw Error('Each demo question must contain 10–500 characters.');return v.trim();});
 return [...new Set(texts)];
}
