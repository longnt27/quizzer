import {readFile,realpath,mkdtemp,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,relative,join,isAbsolute} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {mean,normalizeText,textMetrics,readingOrderMetrics,rankingMetrics,percentile} from './metrics.mjs';

export const digest = value => createHash('sha256').update(value).digest('hex');
export const readJsonl = async path => (await readFile(path,'utf8')).split(/\r?\n/).filter(line=>line.trim()).map(line=>JSON.parse(line));
const rootDefault=fileURLToPath(new URL('./controlled/',import.meta.url));

export function splitPages(content,pageCount) {
  const markers=[...content.matchAll(/(?:^|\n)---\s*Page\s+(\d+)\s*---[^\S\n]*\n?/g)];
  const pages=new Map();
  for(let i=0;i<markers.length;i++){
    const number=Number(markers[i][1]);if(number<1||number>pageCount||pages.has(number))continue;
    pages.set(number,content.slice(markers[i].index+markers[i][0].length,markers[i+1]?.index??content.length).trim());
  }
  if(!markers.length&&pageCount===1)pages.set(1,content.trim());
  return pages;
}

export async function prepareSource(source,gold,{root=rootDefault,mode='raw',variant,extract}={}) {
  if(!['raw','scan','oracle'].includes(mode))throw Error('Invalid extraction mode');
  const chosen=mode==='scan'&&variant ? variant:source;
  const base=await realpath(root),path=resolve(base,chosen.pdf),rel=relative(base,path);
  if(isAbsolute(chosen.pdf)||rel.startsWith('..'))throw Error('Unsafe source path');
  const actual=await realpath(path);if(relative(base,actual).startsWith('..'))throw Error('Unsafe source path');
  const bytes=await readFile(actual);
  if(digest(bytes)!==chosen.sha256)throw Error(`Source hash mismatch: ${source.id}`);
  const pages=gold.filter(g=>g.documentId===source.id).sort((a,b)=>a.page-b.page);
  let content='',parserVersion,reportedPages=0,error;
  const started=performance.now();
  if(mode==='oracle'){
    content=pages.map(g=>`--- Page ${g.page} ---\n${g.blocks.map(b=>b.text).join('\n\n')}`).join('\n\n');
    parserVersion='pre-render-oracle-DIAGNOSTIC';reportedPages=source.pages;
  }else{
    try{
      if(!extract)throw Error('Production extractor dependency missing');
      const result=await extract(bytes,{name:chosen.pdf,mimeType:'application/pdf'});
      content=result.content;parserVersion=result.parserVersion;reportedPages=result.pageCount;
    }catch(e){error=`${e.name}: extraction failed`;}
  }
  const extractionLatencyMs=performance.now()-started;
  const pageTexts=splitPages(content,source.pages);
  if(mode!=='oracle'&&!error&&![...pageTexts.values()].some(text=>text.trim())) error='empty-page-text';
  const scores=pages.map(g=>{
    const text=pageTexts.get(g.page)??'',normalized=normalizeText(text),found=[];
    for(const b of g.blocks){const offset=normalized.indexOf(normalizeText(b.text));if(offset>=0)found.push({id:b.id,offset});}
    found.sort((a,b)=>a.offset-b.offset);
    return {page:g.page,...textMetrics(g.blocks.map(b=>b.text).join('\n'),text),
      blockExactPresence:mean(g.blocks.map(b=>Number(normalized.includes(normalizeText(b.text))))),
      readingOrder:readingOrderMetrics(g.blocks.map(b=>b.id),found.map(b=>b.id)),
      codeBlockExactPresence:mean(g.blocks.filter(b=>b.type==='code').map(b=>Number(normalized.includes(normalizeText(b.text))))),
      formulaExactPresence:mean(g.blocks.filter(b=>b.type==='formula').map(b=>Number(normalized.includes(normalizeText(b.text))))),
      pagePresent:pageTexts.has(g.page)};
  });
  return {id:source.id,content,parserVersion,error,oracle:mode==='oracle',rawSha256:chosen.sha256,
    extraction:{id:source.id,language:source.language,variant:mode==='scan'&&variant ? variant.variant:'native',
      latencyMs:extractionLatencyMs,error,expectedPages:source.pages,reportedPages:reportedPages??null,
      pageCountCorrect:reportedPages===source.pages,pages:scores,
      structureMetricsStatus:'Structured tables/boxes require an extractor adapter; text presence is not table structure accuracy'}};
}

export function retrievalInput(task,contextBudget=4096) {
  return {query:[...(task.history??[]).map(h=>h.content),task.query].join('\n'),
    documentIds:[...task.documentIds],limit:10,includeNeighbors:false,contextBudget};
}

export function summarizeRetrieval(rows) {
  const summarize=items=>{
    const ks=[...new Set(items.flatMap(r=>Object.keys(r.metrics)))];const result={};
    for(const k of ks){const names=[...new Set(items.flatMap(r=>Object.keys(r.metrics[k]??{})))];result[k]={};
      for(const name of names)if(!['k','returnedPages'].includes(name))result[k][name]=mean(items.map(r=>r.metrics[k]?.[name]).filter(v=>typeof v==='number'));}
    return result;
  };
  const slices=field=>Object.fromEntries([...new Set(rows.map(r=>r[field]))].map(v=>[v,summarize(rows.filter(r=>r[field]===v))]));
  return {tasks:rows.length,overall:summarize(rows),byLanguage:slices('language'),byIntent:slices('intent'),
    p50LatencyMs:percentile(rows.map(r=>r.latencyMs),50),p95LatencyMs:percentile(rows.map(r=>r.latencyMs),95)};
}

export async function runBenchmark({root=rootDefault,mode='raw',split='test',contextBudget=4096}={}) {
  if(!['dev','validation','test'].includes(split))throw Error('Invalid split');
  if(!['raw','scan','oracle'].includes(mode))throw Error('Invalid mode');
  if(!Number.isSafeInteger(contextBudget)||contextBudget<256||contextBudget>65536)throw Error('Invalid context budget');
  const manifest=JSON.parse(await readFile(join(root,'manifest.json'),'utf8'));
  for(const [name,pin] of [['sources.jsonl',manifest.sourcesSha256],['tasks.jsonl',manifest.tasksSha256]])if(digest(await readFile(join(root,name)))!==pin)throw Error(`Manifest hash mismatch: ${name}`);
  const allSources=await readJsonl(join(root,'sources.jsonl')),sources=allSources.filter(s=>s.split===split);
  const allCases=await readJsonl(join(root,'tasks.jsonl')),cases=allCases.filter(c=>c.split===split);
  const gold=await readJsonl(join(root,'extraction-gold.jsonl')),variants=await readJsonl(join(root,'variants.jsonl'));
  if(!sources.length||!cases.length)throw Error('Empty benchmark split');
  const allowed=new Set(sources.map(s=>s.id));
  if(cases.some(c=>!c.documentIds.length||c.documentIds.some(id=>!allowed.has(id))))throw Error('Cross-split or missing source scope');
  const {extractDocumentBuffer,chunkDocument}=await import('../../server/document-import.mjs');
  const {SparseDocumentIndex}=await import('../../server/sparse-index.mjs');
  const temporary=await mkdtemp(join(tmpdir(),'quizzer-rag-lab-'));
  const index=new SparseDocumentIndex(join(temporary,'index.sqlite'));
  const extraction=[],details=[];
  try{
    for(const source of sources){
      const prepared=await prepareSource(source,gold,{root,mode,variant:variants.find(v=>v.documentId===source.id),extract:extractDocumentBuffer});
      extraction.push(prepared.extraction);
      if(!prepared.error&&prepared.content.trim())index.indexDocument({id:source.id,data:{id:source.id,name:source.title,tags:[source.family,source.language],
        content:prepared.content,parserVersion:prepared.parserVersion,chunks:chunkDocument(source.id,prepared.content)}});
    }
    for(const task of cases){
      const start=performance.now();let results=[],refused=false,error,estimatedContextTokens=0;
      try{
        const result=index.retrieve(retrievalInput(task,contextBudget));
        if(result.results.some(r=>!task.documentIds.includes(r.documentId)))throw Error('Out-of-scope retrieval result');
        results=result.results.map(r=>({documentId:r.documentId,page:r.page,sourceSpanId:r.sourceSpanId}));
        refused=Boolean(result.refusal);estimatedContextTokens=result.estimatedContextTokens;
      }catch(e){error=`${e.name}: retrieval failed`;}
      const metrics=Object.fromEntries([1,3,5,10].map(k=>[k,rankingMetrics(task.gold.evidenceGroups,results,k)]));
      details.push({id:task.id,scenarioId:task.scenarioId,group:task.sourceFamily,intent:task.intent,language:task.language,
        expectedAction:task.gold.action,latencyMs:performance.now()-start,estimatedContextTokens,refused,error,results,metrics});
    }
  }finally{index.close();await rm(temporary,{recursive:true,force:true});}
  const pages=extraction.flatMap(e=>e.pages),negative=details.filter(d=>d.expectedAction==='abstain'),answerable=details.filter(d=>['answer','partial','conflict'].includes(d.expectedAction));
  return {schemaVersion:1,createdAt:new Date().toISOString(),mode,split,
    pipeline:'production extractDocumentBuffer -> production chunkDocument -> production SparseDocumentIndex',
    diagnosticOnly:mode==='oracle',generatorUsed:false,sourceSnapshot:manifest.sourcesSha256,taskSnapshot:manifest.tasksSha256,
    protocol:{retrieval:'sparse-bm25',contextBudget,neighbors:false,cutoffs:[1,3,5,10],relevanceUnit:'unique physical PDF page',textNormalization:'NFC and collapsed whitespace'},
    runtime:{node:process.version,platform:process.platform,arch:process.arch},
    extractionSummary:{documents:extraction.length,pages:pages.length,failedDocuments:extraction.filter(e=>e.error).length,
      macroCER:mean(pages.map(p=>p.characterErrorRate).filter(v=>v!==null)),macroWER:mean(pages.map(p=>p.wordErrorRate).filter(v=>v!==null)),
      blockExactPresence:mean(pages.map(p=>p.blockExactPresence)),pagePresence:mean(pages.map(p=>Number(p.pagePresent))),
      p50LatencyMs:percentile(extraction.map(e=>e.latencyMs),50),p95LatencyMs:percentile(extraction.map(e=>e.latencyMs),95)},
    retrieval:{...summarizeRetrieval(details),negativeRefusalRate:mean(negative.map(d=>Number(d.refused&&!d.error))),
      falseRefusalRate:mean(answerable.map(d=>Number(d.refused&&!d.error))),errors:details.filter(d=>d.error).length},
    extraction,details,limitations:['Controlled synthetic scenarios, not natural-course quality scores.',
      'Page relevance and text-presence scores are not citation entailment, visual understanding, or table structure accuracy.',
      'No generation, human review, or improved learning claim is implied.']};
}

export async function runRealExtraction(root=fileURLToPath(new URL('./corpus/',import.meta.url))) {
  const sources=JSON.parse(await readFile(join(root,'sources.json'),'utf8'));
  const {extractDocumentBuffer}=await import('../../server/document-import.mjs');
  const rows=[];
  for(const source of sources){
    const prepared=await prepareSource(source,[],{root,mode:'raw',extract:extractDocumentBuffer});
    const pages=splitPages(prepared.content,source.pages);
    rows.push({id:source.id,family:source.family,sourceSha256:source.sha256,parserVersion:prepared.parserVersion,
      ...prepared.extraction,characters:prepared.content.length,emptyPages:Array.from({length:source.pages},(_,i)=>i+1).filter(n=>!pages.get(n)?.trim()).length});
  }
  return {schemaVersion:1,kind:'natural-source-extraction-observation',sourceCount:rows.length,
    failedDocuments:rows.filter(r=>r.error).length,rows,
    limitation:'No human transcription exists for these sources. Character count, page count and extraction success are observability, NOT accuracy.'};
}
