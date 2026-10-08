/** Metric primitives. Null means undefined, never an automatic perfect score. */
export const mean = values => values.length ? values.reduce((a,b)=>a+b,0)/values.length : null;
export const normalizeText = value => String(value ?? '').normalize('NFC').replace(/\s+/gu,' ').trim();
const ratio = (a,b) => b ? a/b : null;
const key = item => `${item.documentId}:${item.page}`;
const unique = values => [...new Set(values)];
const fail = message => { throw new Error(message); };

export function rankingMetrics(groups, retrieved, k=5) {
  if (!Number.isSafeInteger(k) || k<1 || k>100) fail('k must be an integer from 1 to 100');
  const acceptable = groups.map(g => new Set(g.alternatives.map(key)));
  const relevant = new Set(acceptable.flatMap(g=>[...g]));
  const ranking = unique(retrieved.map(key)).slice(0,k);
  const labels = ranking.map(k=>relevant.has(k) ? 1:0);
  const hits = labels.reduce((a,b)=>a+b,0);
  const covered = acceptable.filter(g=>ranking.some(k=>g.has(k))).length;
  let seen=0, ap=0;
  labels.forEach((hit,i)=>{seen+=hit;if(hit) ap+=seen/(i+1);});
  const dcg=labels.reduce((sum,hit,i)=>sum+hit/Math.log2(i+2),0);
  const ideal=Array.from({length:Math.min(k,relevant.size)},(_,i)=>1/Math.log2(i+2)).reduce((a,b)=>a+b,0);
  return {k,returnedPages:ranking.length,precision:relevant.size ? hits/k:null,
    pageRecall:ratio(hits,relevant.size),evidenceRecall:ratio(covered,acceptable.length),
    completeEvidence:acceptable.length ? Number(covered===acceptable.length):null,
    mrr:relevant.size ? (labels.includes(1) ? 1/(labels.indexOf(1)+1):0):null,
    averagePrecision:ratio(ap,relevant.size),ndcg:ratio(dcg,ideal)};
}

function editDistance(a,b) {
  let start=0;while(start<a.length && start<b.length && a[start]===b[start]) start++;
  a=a.slice(start);b=b.slice(start);
  while(a.length && b.length && a.at(-1)===b.at(-1)){a=a.slice(0,-1);b=b.slice(0,-1);}
  if(a.length<b.length) [a,b]=[b,a];
  if(!b.length) return a.length;
  let previous=Uint32Array.from({length:b.length+1},(_,i)=>i), current=new Uint32Array(b.length+1);
  for(let i=1;i<=a.length;i++){
    current[0]=i;
    for(let j=1;j<=b.length;j++) current[j]=Math.min(previous[j]+1,current[j-1]+1,previous[j-1]+Number(a[i-1]!==b[j-1]));
    [previous,current]=[current,previous];
  }
  return previous[b.length];
}

export function textMetrics(reference,hypothesis) {
  const a=normalizeText(reference),b=normalizeText(hypothesis);
  const chars=[...a],words=a ? a.split(' '):[];
  return {characterErrorRate:ratio(editDistance(chars,[...b]),chars.length),
    wordErrorRate:ratio(editDistance(words,b ? b.split(' '):[]),words.length),
    exactMatch:Number(a===b),referenceCharacters:chars.length,hypothesisCharacters:[...b].length};
}

export function tableCellMetrics(reference,prediction) {
  const cells=rows=>new Set(rows.flatMap((row,r)=>row.map((v,c)=>`${r}:${c}:${normalizeText(v)}`)));
  const gold=cells(reference),out=cells(prediction);const hits=[...out].filter(v=>gold.has(v)).length;
  return {precision:ratio(hits,out.size),recall:ratio(hits,gold.size),
    f1:gold.size+out.size ? 2*hits/(gold.size+out.size):null,referenceCells:gold.size,predictedCells:out.size};
}

export function readingOrderMetrics(reference,prediction) {
  const expected=unique(reference),observed=unique(prediction).filter(v=>expected.includes(v));
  let correct=0,pairs=0;
  for(let i=0;i<observed.length;i++)for(let j=i+1;j<observed.length;j++){
    pairs++;correct+=Number(expected.indexOf(observed[i])<expected.indexOf(observed[j]));
  }
  return {coverage:ratio(observed.length,expected.length),pairwiseAccuracy:ratio(correct,pairs),comparedPairs:pairs};
}

export function boxIoU(a,b) {
  for(const v of [a,b]) if(!Array.isArray(v)||v.length!==4||v.some(x=>!Number.isFinite(x)||x<0||x>1)||v[2]<v[0]||v[3]<v[1]) fail('Invalid normalized bounding box');
  const area=v=>(v[2]-v[0])*(v[3]-v[1]);
  const intersection=Math.max(0,Math.min(a[2],b[2])-Math.max(a[0],b[0]))*Math.max(0,Math.min(a[3],b[3])-Math.max(a[1],b[1]));
  return ratio(intersection,area(a)+area(b)-intersection);
}

const canonical = value => Array.isArray(value) ? JSON.stringify(value.map(canonical).sort())
  : value && typeof value==='object' ? JSON.stringify(Object.keys(value).sort().map(k=>[k,canonical(value[k])])) : JSON.stringify(value);
const sameSet = (a,b) => canonical(unique(a))===canonical(unique(b));

export function scoreResponses(cases,predictions) {
  const ids=new Set(cases.map(c=>c.id));if(ids.size!==cases.length) fail('Duplicate gold IDs');
  const byId=new Map();for(const p of predictions){if(!ids.has(p.id)||byId.has(p.id)) fail('Unknown or duplicate prediction ID');byId.set(p.id,p);}
  const details=[],confusion={};let slotHits=0,slots=0;
  for(const c of cases){
    const p=byId.get(c.id),ok=Boolean(p&&!p.error),action=ok ? p.action ?? 'missing':'missing';
    const expected=c.gold.action;confusion[expected]??={};confusion[expected][action]=(confusion[expected][action]??0)+1;
    const gold=c.gold.answers??{},answer=ok ? p.answers??{}:{};
    const keys=Object.keys(gold);const found=keys.filter(k=>canonical(gold[k])===canonical(answer[k])).length;
    slotHits+=found;slots+=keys.length;
    const extra=Object.keys(answer).filter(k=>!keys.includes(k));
    const missingCorrect=sameSet(c.gold.missingInformation??[],ok ? p.missingInformation??[]:[]);
    details.push({id:c.id,group:c.sourceFamily??c.scenarioId??c.id,intent:c.intent,language:c.language,
      actionCorrect:Number(ok&&action===expected),answerSlotsCorrect:found,answerSlots:keys.length,
      missingInformationCorrect:Number(ok&&missingCorrect),unsupportedAnswerSlots:extra.length,
      strictSuccess:Number(ok&&action===expected&&found===keys.length&&!extra.length&&missingCorrect),
      error:!ok});
  }
  const labels=Object.keys(confusion);
  const f1=labels.map(label=>{
    const tp=confusion[label]?.[label]??0;
    const fn=Object.values(confusion[label]??{}).reduce((a,b)=>a+b,0)-tp;
    const fp=labels.filter(l=>l!==label).reduce((s,l)=>s+(confusion[l]?.[label]??0),0);
    return 2*tp/(2*tp+fp+fn);
  });
  return {cases:cases.length,actionAccuracy:mean(details.map(d=>d.actionCorrect)),actionMacroF1:mean(f1),
    answerSlotAccuracy:ratio(slotHits,slots),strictTaskSuccess:mean(details.map(d=>d.strictSuccess)),
    errorRate:mean(details.map(d=>Number(d.error))),confusion,details};
}

export function percentile(values,p) {
  if(!Number.isFinite(p)||p<0||p>100||values.some(v=>!Number.isFinite(v))) fail('Invalid percentile input');
  if(!values.length) return null;
  const sorted=[...values].sort((a,b)=>a-b);return sorted[Math.max(0,Math.ceil(p/100*sorted.length)-1)];
}

export function pairedBootstrap(a,b,{replicates=2000,seed=20261008}={}) {
  if(!Number.isSafeInteger(replicates)||replicates<100||replicates>100000) fail('Invalid replicate count');
  if(new Set(a.map(r=>r.id)).size!==a.length||new Set(b.map(r=>r.id)).size!==b.length||a.length!==b.length) fail('Runs must contain unique paired IDs');
  const byId=new Map(b.map(r=>[r.id,r])),groups=new Map();
  for(const x of a){const y=byId.get(x.id);if(!y||x.group!==y.group||!Number.isFinite(x.score)||!Number.isFinite(y.score)) fail('Runs must use matching groups and finite scores');
    if(!groups.has(x.group))groups.set(x.group,[]);groups.get(x.group).push(y.score-x.score);}
  const deltas=[...groups.values()].map(mean),point=mean(deltas);
  if(deltas.length<2)return {groups:deltas.length,meanDelta:point,interval95:null,reason:'At least two independent groups are required'};
  let state=seed>>>0;const random=()=>{state=(1664525*state+1013904223)>>>0;return state/4294967296;};
  const draws=Array.from({length:replicates},()=>mean(deltas.map(()=>deltas[Math.floor(random()*deltas.length)])));
  return {groups:deltas.length,meanDelta:point,interval95:[percentile(draws,2.5),percentile(draws,97.5)],
    estimand:'equal-weight source-group mean difference',replicates,seed,
    limitation:'Conditional on these source groups; shared templates do not establish population independence'};
}
