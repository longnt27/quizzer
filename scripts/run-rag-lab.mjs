#!/usr/bin/env node
import {parseArgs} from 'node:util';
import {readFile, writeFile, access} from 'node:fs/promises';
import {runBenchmark, runRealExtraction, readJsonl} from '../eval/rag-lab/runner.mjs';
import {scoreResponses, pairedBootstrap} from '../eval/rag-lab/metrics.mjs';
import {synthesizeCandidates} from '../eval/rag-lab/synthesis.mjs';

const usage = `Quizzer RAG lab

  node scripts/run-rag-lab.mjs benchmark --mode raw|scan|oracle --split dev|validation|test --out result.json
  node scripts/run-rag-lab.mjs real-extraction --out real-extraction.json
  node scripts/run-rag-lab.mjs score --tasks tasks.jsonl --predictions outputs.jsonl --out scores.json
  node scripts/run-rag-lab.mjs compare --left raw.json --right oracle.json --out comparison.json
  node scripts/run-rag-lab.mjs synthesize --model INSTALLED_MODEL --acknowledge-local-model --split dev --limit 24 --out candidates.jsonl

Optional: --root CORPUS_DIRECTORY, --context-budget 4096, --endpoint http://127.0.0.1:11434
Raw and scan modes use production PDF extraction and sparse retrieval. Oracle is a diagnostic, not end-to-end.
Synthesis is local-only, bounded, opt-in, never pulls a model, and produces candidates rather than reviewed gold.
Outputs must not already exist. No paid API calls are made by these commands.
`;

async function main() {
  const {values:v, positionals} = parseArgs({allowPositionals:true, options: {
    help:{type:'boolean'}, mode:{type:'string'}, split:{type:'string'}, out:{type:'string'}, root:{type:'string'},
    tasks:{type:'string'}, predictions:{type:'string'}, left:{type:'string'}, right:{type:'string'},
    model:{type:'string'}, endpoint:{type:'string'}, limit:{type:'string'},
    'context-budget':{type:'string'}, 'acknowledge-local-model':{type:'boolean'},
  }});
  if (v.help || !positionals.length) { process.stdout.write(usage); return; }
  if (positionals.length !== 1) throw Error('Exactly one command is required');
  const command = positionals[0];
  if (!['benchmark','real-extraction','score','compare','synthesize'].includes(command)) throw Error('Unknown command');
  if (v.mode && !['raw','scan','oracle'].includes(v.mode)) throw Error('Invalid mode');
  if (!v.out) throw Error('--out is required');
  const exists = await access(v.out).then(()=>true,()=>false);
  if (exists) throw Error('Output exists; select a fresh run filename');
  let result;
  if (command === 'benchmark') result = await runBenchmark({root:v.root,mode:v.mode??'raw',split:v.split??'test',contextBudget:Number(v['context-budget']??4096)});
  else if (command === 'real-extraction') result = await runRealExtraction(v.root);
  else if (command === 'score') {
    if (!v.tasks || !v.predictions) throw Error('--tasks and --predictions are required');
    const cases = await readJsonl(v.tasks), predictions = await readJsonl(v.predictions);
    result = {schemaVersion:1,kind:'controlled-response-evaluation',...scoreResponses(cases,predictions),
      limitation:'Structured answer checks do not establish free-text entailment or human-rated quiz quality.'};
  } else if (command === 'compare') {
    if (!v.left || !v.right) throw Error('--left and --right are required');
    const a = JSON.parse(await readFile(v.left,'utf8')), b = JSON.parse(await readFile(v.right,'utf8'));
    for (const field of ['sourceSnapshot','taskSnapshot','split','protocol']) {
      if (a[field] === undefined || JSON.stringify(a[field]) !== JSON.stringify(b[field])) throw Error(`Incompatible comparison: ${field}`);
    }
    const metricRows = run => run.details.filter(d=>d.metrics['5'].evidenceRecall!==null)
      .map(d=>({id:d.id,group:d.group,score:d.metrics['5'].evidenceRecall}));
    result = {schemaVersion:1,kind:'paired-extraction-condition-comparison',left:a.mode,right:b.mode,
      metric:'required evidence recall@5',...pairedBootstrap(metricRows(a),metricRows(b)),
      warning:'This is conditional controlled-template uncertainty, not proof of broad-domain generalization.'};
  } else {
    result = await synthesizeCandidates({root:v.root,model:v.model,endpoint:v.endpoint,acknowledgeLocalModel:v['acknowledge-local-model'],limit:Number(v.limit??24),split:v.split??'dev',output:v.out});
    process.stdout.write(`${JSON.stringify({output:v.out,candidates:result.candidates,requestedCalls:result.requestedCalls})}\n`);
    return;
  }
  await writeFile(v.out, `${JSON.stringify(result,null,2)}\n`, {flag:'wx'});
  process.stdout.write(`${JSON.stringify({output:v.out,kind:result.kind??'raw-PDF-benchmark',mode:result.mode,split:result.split,tasks:result.retrieval?.tasks,extraction:result.extractionSummary})}\n`);
}
main().catch(error=>{process.stderr.write(`${error.message}\n`);process.exitCode=1;});
