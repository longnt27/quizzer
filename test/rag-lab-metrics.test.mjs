import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
const path = new URL('../eval/rag-lab/metrics.mjs', import.meta.url);
const load = async () => { assert.ok(existsSync(path), 'RAG lab metrics are not implemented'); return import(path); };
const groups = [{alternatives:[{documentId:'a',page:1,blockId:'x'},{documentId:'a',page:2,blockId:'alternative'}]}, {alternatives:[{documentId:'b',page:3,blockId:'y'}]}];
test('alternative evidence is sufficient, duplicate pages earn no extra credit', async()=>{
 const {rankingMetrics}=await load();const m=rankingMetrics(groups,[{documentId:'a',page:2},{documentId:'a',page:2},{documentId:'b',page:3}],5);
 assert.equal(m.evidenceRecall,1);assert.equal(m.completeEvidence,1);assert.equal(m.precision,2/5);assert.equal(m.returnedPages,2);
});
test('missed evidence and missing predictions are zero, no qrels is not perfect', async()=>{
 const {rankingMetrics}=await load();assert.equal(rankingMetrics(groups,[],5).evidenceRecall,0);assert.equal(rankingMetrics([],[],5).evidenceRecall,null);
});
test('MRR, AP, and nDCG use actual positions', async()=>{
 const {rankingMetrics}=await load();const g=[{alternatives:[{documentId:'a',page:1}]}];const m=rankingMetrics(g,[{documentId:'z',page:9},{documentId:'a',page:1}],3);
 assert.equal(m.mrr,.5);assert.equal(m.averagePrecision,.5);assert.ok(Math.abs(m.ndcg-1/Math.log2(3))<1e-10);
});
test('text errors distinguish substitutions and empty extraction',async()=>{
 const {textMetrics}=await load();assert.equal(textMetrics('cat dog','cat fog').wordErrorRate,.5);assert.equal(textMetrics('abc','').characterErrorRate,1);assert.equal(textMetrics('','').characterErrorRate,null);
});
test('Unicode normalization preserves accent errors',async()=>{
 const {textMetrics}=await load();assert.equal(textMetrics('\u00e9','e\u0301').characterErrorRate,0);assert.equal(textMetrics('\u00e9','e').characterErrorRate,1);
});
test('table cells require correct row/column coordinates',async()=>{
 const {tableCellMetrics}=await load();assert.equal(tableCellMetrics([['a','b']],[['b','a']]).f1,0);assert.equal(tableCellMetrics([['a']],[]).recall,0);
});
test('reading order penalizes inversions and reports missing coverage',async()=>{
 const {readingOrderMetrics}=await load();let m=readingOrderMetrics(['a','b','c'],['c','b','a']);assert.equal(m.pairwiseAccuracy,0);m=readingOrderMetrics(['a','b','c'],['a']);assert.equal(m.coverage,1/3);assert.equal(m.pairwiseAccuracy,null);
});
test('bounding-box IoU cannot be faked by text agreement',async()=>{
 const {boxIoU}=await load();assert.equal(boxIoU([0,0,1,1],[0,0,1,1]),1);assert.equal(boxIoU([0,0,.1,.1],[.9,.9,1,1]),0);assert.throws(()=>boxIoU([1,0,0,1],[0,0,1,1]));
});
test('action scoring separates clarification from abstention',async()=>{
 const {scoreResponses}=await load();const cases=[{id:'1',gold:{action:'clarify',answers:{},missingInformation:['region']}}];const r=scoreResponses(cases,[{id:'1',action:'abstain',answers:{},missingInformation:['region']}]);assert.equal(r.actionAccuracy,0);assert.equal(r.strictTaskSuccess,0);
});
test('partial answers need known values and explicit missing slots',async()=>{
 const {scoreResponses}=await load();const c=[{id:'1',gold:{action:'partial',answers:{north:3},missingInformation:['live']}}];assert.equal(scoreResponses(c,[{id:'1',action:'partial',answers:{north:3},missingInformation:[]}]).strictTaskSuccess,0);assert.equal(scoreResponses(c,[{id:'1',action:'partial',answers:{north:3},missingInformation:['live']}]).strictTaskSuccess,1);
});
test('unknown tasks and duplicate predictions are rejected',async()=>{
 const {scoreResponses}=await load();const c=[{id:'a',gold:{action:'answer',answers:{v:1},missingInformation:[]}}];assert.throws(()=>scoreResponses(c,[{id:'x'}]));assert.throws(()=>scoreResponses(c,[{id:'a'},{id:'a'}]));
});
test('unsupported answer slots fail strict scoring and errors stay in denominators',async()=>{
 const {scoreResponses}=await load();const c=[{id:'a',gold:{action:'answer',answers:{v:1},missingInformation:[]}}];assert.equal(scoreResponses(c,[{id:'a',action:'answer',answers:{v:1,extra:7}}]).strictTaskSuccess,0);assert.equal(scoreResponses(c,[]).actionAccuracy,0);
});
test('conflict observation ordering does not change correctness',async()=>{
 const {scoreResponses}=await load();const c=[{id:'a',gold:{action:'conflict',answers:{observations:[1,2]},missingInformation:['conflict']}}];assert.equal(scoreResponses(c,[{id:'a',action:'conflict',answers:{observations:[2,1]},missingInformation:['conflict']}]).strictTaskSuccess,1);
});
test('paired uncertainty resamples groups, rejects unpaired input, and is reproducible',async()=>{
 const {pairedBootstrap}=await load();const a=[{id:'a',group:'g1',score:0},{id:'b',group:'g2',score:.5}],b=[{id:'a',group:'g1',score:1},{id:'b',group:'g2',score:1}];const x=pairedBootstrap(a,b,{replicates:100,seed:9});assert.equal(x.groups,2);assert.equal(x.meanDelta,.75);assert.deepEqual(x,pairedBootstrap(a,b,{replicates:100,seed:9}));assert.throws(()=>pairedBootstrap(a,b.slice(0,1)));
});
test('single family does not produce a population interval',async()=>{
 const {pairedBootstrap}=await load();const a=[{id:'a',group:'same',score:0}],b=[{id:'a',group:'same',score:1}];assert.equal(pairedBootstrap(a,b).interval95,null);
});
test('percentiles and empty denominators are explicit',async()=>{
 const {percentile}=await load();assert.equal(percentile([],95),null);assert.equal(percentile([1,2,3,4,5],95),5);
});
