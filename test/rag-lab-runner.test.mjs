import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
const modulePath=new URL('../eval/rag-lab/runner.mjs',import.meta.url);
const load=async()=>{assert.ok(existsSync(modulePath),'production runner not implemented');return import(modulePath);};
async function fixture(fn){
 const dir=await mkdtemp(join(tmpdir(),'rag-lab-test-'));const data=Buffer.from('%PDF-test-binary');await writeFile(join(dir,'a.pdf'),data);
 const source={id:'a',pdf:'a.pdf',sha256:createHash('sha256').update(data).digest('hex'),pages:1,split:'test',title:'source'};
 const gold=[{documentId:'a',page:1,blocks:[{id:'fact',type:'paragraph',text:'North is 42.'}]}];
 try{await fn({dir,source,gold});}finally{await rm(dir,{recursive:true,force:true});}
}
test('raw PDF mode sends bytes to the production extraction contract',async()=>fixture(async({dir,source,gold})=>{
 const {prepareSource}=await load();let calls=0;const out=await prepareSource(source,gold,{root:dir,mode:'raw',extract:async bytes=>{calls++;assert.equal(bytes.subarray(0,5).toString(),'%PDF-');return {content:'--- Page 1 ---\nNorth is 42.',pageCount:1,parserVersion:'fixture'};}});
 assert.equal(calls,1);assert.equal(out.extraction.pages[0].characterErrorRate,0);assert.equal(out.oracle,false);
}));
test('extraction errors never substitute gold text',async()=>fixture(async({dir,source,gold})=>{
 const {prepareSource}=await load();const out=await prepareSource(source,gold,{root:dir,mode:'raw',extract:async()=>{throw Error('failure');}});assert.equal(out.content,'');assert.equal(out.extraction.pages[0].characterErrorRate,1);assert.ok(out.error);
}));
test('oracle mode is explicit and does not execute extraction',async()=>fixture(async({dir,source,gold})=>{
 const {prepareSource}=await load();const out=await prepareSource(source,gold,{root:dir,mode:'oracle',extract:async()=>assert.fail('oracle should not extract')});assert.equal(out.oracle,true);assert.match(out.content,/North is 42/);
}));
test('source mismatch aborts rather than becoming a low score',async()=>fixture(async({dir,source,gold})=>{
 const {prepareSource}=await load();await assert.rejects(()=>prepareSource({...source,sha256:'0'.repeat(64)},gold,{root:dir,mode:'raw',extract:async()=>assert.fail()}),/hash/i);
}));
test('path traversal and invalid modes are rejected',async()=>fixture(async({dir,source,gold})=>{
 const {prepareSource}=await load();await assert.rejects(()=>prepareSource({...source,pdf:'../secret.pdf'},gold,{root:dir,mode:'raw'}),/path/i);await assert.rejects(()=>prepareSource(source,gold,{root:dir,mode:'magic'}),/mode/i);
}));
test('missing page markers remain missing pages, not invented perfect segmentation',async()=>{
 const {splitPages}=await load();assert.deepEqual([...splitPages('unsegmented text',2)],[]);assert.equal(splitPages('--- Page 2 ---\nsecond',2).get(2),'second');
});
test('ranking requests contain history and selected scope but never gold',async()=>{
 const {retrievalInput}=await load();const input=retrievalInput({id:'a',query:'its limit?',history:[{role:'user',content:'North'}],documentIds:['d'],gold:{answer:42},intent:'secret'},512);
 assert.deepEqual(input.documentIds,['d']);assert.match(input.query,/North/);assert.equal(input.contextBudget,512);assert.equal(input.includeNeighbors,false);assert.ok(!JSON.stringify(input).includes('42'));
});
test('batch summary includes zero scores and splits languages',async()=>{
 const {summarizeRetrieval}=await load();const rows=[{id:'a',language:'en',intent:'x',latencyMs:5,metrics:{'5':{evidenceRecall:1}}},{id:'b',language:'vi',intent:'y',latencyMs:7,metrics:{'5':{evidenceRecall:0}}}];const m=summarizeRetrieval(rows);assert.equal(m.overall['5'].evidenceRecall,.5);assert.equal(m.byLanguage.vi['5'].evidenceRecall,0);
});
test('page markers without extracted content count as extraction failure',async()=>fixture(async({dir,source,gold})=>{
 const {prepareSource}=await load();const out=await prepareSource(source,gold,{root:dir,mode:'raw',extract:async()=>({content:'--- Page 1 ---\n',pageCount:1,parserVersion:'empty'})});assert.equal(out.error,'empty-page-text');assert.equal(out.extraction.pages[0].characterErrorRate,1);
}));
