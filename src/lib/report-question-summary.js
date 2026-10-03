// Arithmetic for the analyst, not a new brand detector or intent classifier.
// Source labels describe how questions were collected, never their intent.
const count=v=>Number.isSafeInteger(v)&&v>=0;
export function questionSummary(questions){
 const ids=new Set();
 for(const q of questions){
  if(q.id==null||ids.has(String(q.id)))throw Error('Question summary requires unique question IDs.');
  ids.add(String(q.id));
 }
 const summarize=rows=>{
  const result={questionCount:rows.length,questionIds:rows.map(q=>q.id),measuredAnswers:0,questionsWithUnknownMeasurement:0};
  for(const q of rows){if(count(q.measured))result.measuredAnswers+=q.measured;else result.questionsWithUnknownMeasurement++;}
  for(const metric of ['named','cited']){
   const eligible=rows.filter(q=>count(q.measured)&&q.measured>0&&count(q[metric])&&q[metric]<=q.measured);
   const numerator=eligible.reduce((n,q)=>n+q[metric],0),denominator=eligible.reduce((n,q)=>n+q.measured,0);
   result[metric]={answers:denominator?numerator:null,measuredAnswerDenominator:denominator,rate:denominator?numerator/denominator:null,
    eligibleQuestionCount:eligible.length,excludedQuestionCount:rows.length-eligible.length,
    zeroInMeasuredAnswersQuestionCount:eligible.filter(q=>q[metric]===0).length,
    zeroInMeasuredAnswersQuestionIds:eligible.filter(q=>q[metric]===0).map(q=>q.id)};
  }
  return result;
 };
 const sources=[...new Set(questions.map(q=>q.source||'unknown'))].sort();
 return {basis:'Calculated from supplied question rows. Zero means zero within measured answers, not never mentioned. Failed and unmeasured answers are excluded. Naming and citation use their own known-result denominators.',
  groupingRule:'Groups below are collection sources only. GSC-derived does not mean branded; generated does not mean unbranded. No approved intent classification is supplied. Do not publish counts or rates for invented semantic groups.',
  all:summarize(questions),bySource:sources.map(source=>({source,...summarize(questions.filter(q=>(q.source||'unknown')===source))}))};
}
