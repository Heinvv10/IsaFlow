/** Explicit local fixture only. Checkpoint each call; failed shards retain honest partial evidence. */
import {writeFile,rename,readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {runMcpHttpAcceptance,runMcpReadAcceptance} from '../../tests/integration/mcp-http/fixtures';
import {acceptanceCases,aggregateCoverage,migrateCaseProof,type ComparedCase,type GatePhase} from '../../tests/integration/mcp-http/contractCases';
import {createHash} from 'node:crypto';
import type {Contract} from '../../tests/integration/mcp-http/contractSamples';
const [output,phase,shard='0',size='500']=process.argv.slice(2);
if(!output)throw new Error('Usage: bun scripts/forensic/mcp-http-acceptance.ts <evidence.json> [fields|scope|post|current|all|reads] [shard] [size<=600]');
if(phase&&!['all','fields','scope','post','current','reads','sources','aggregate','migrate'].includes(phase))throw new Error('Invalid phase');
const target=resolve(output);
async function checkpoint(evidence:unknown){
 const temporary=`${target}.partial`;await writeFile(temporary,`${JSON.stringify(evidence,null,2)}\n`,{mode:0o600});await rename(temporary,target);
}
let result:unknown;
if(phase!=='aggregate'&&phase!=='migrate')await checkpoint({outcome:'running',complete:false,executed:[],note:'No acceptance checks completed in this invocation yet'});
if(phase==='aggregate'||phase==='migrate'){
 const inventory=JSON.parse(await readFile('docs/superpowers/plans/forensic-evidence/tool-contract-current.json','utf8')) as {tools:Contract[]};
 const cases=acceptanceCases(inventory.tools),hash=createHash('sha256').update(JSON.stringify(cases)).digest('hex');
 const paths=process.argv.slice(phase==='migrate'?5:4);if(!paths.length)throw new Error('Aggregate requires evidence paths');
 const reports=await Promise.all(paths.map(async path=>JSON.parse(await readFile(path,'utf8')) as unknown));
 if(phase==='aggregate')result=aggregateCoverage(cases,hash,reports);
 else{
  const oldPath=process.argv[4]!;const oldRaw=await readFile(oldPath,'utf8');
  const old=JSON.parse(oldRaw) as {sourceCommit:string;cases:ComparedCase[];planHash:string};
  if(!/^[a-f0-9]{40}$/.test(old.sourceCommit)||createHash('sha256').update(JSON.stringify(old.cases)).digest('hex')!==old.planHash)throw new Error('Invalid named old plan');
  const prior=aggregateCoverage(old.cases,old.planHash,reports),comparison=migrateCaseProof(old.cases,cases,prior.executedCaseIds);
  const unchanged=new Set(comparison.unchangedCaseIds);
  result={outcome:'passed',version:2,planHash:hash,build:prior.buildProvenance[0],executed:cases.filter(row=>unchanged.has(row.id)).map(row=>({id:row.id,tool:row.tool,phase:row.phase,committedRefusal:true})),
   migration:{fromPlanHash:old.planHash,toPlanHash:hash,oldSourceCommit:old.sourceCommit,oldPlanPath:oldPath,oldPlanSha256:createHash('sha256').update(oldRaw).digest('hex'),
    originalReports:await Promise.all(paths.map(async path=>({path,sha256:createHash('sha256').update(await readFile(path)).digest('hex')}))),...comparison},
   complete:false,limitations:['Separate explicit case-plan migration; original evidence files unmodified','Only byte-identical completed cases reused','Build provenance is external local verification, not a signed server claim']};
 }
}else if(phase==='sources')result=await (await import('../../tests/integration/mcp-http/currentAuthorityFixture')).runCurrentSourceAcceptance(process.env);
else result=phase==='reads'?await runMcpReadAcceptance(process.env):await runMcpHttpAcceptance(process.env,{phase:phase&&phase!=='all'?phase as GatePhase:undefined,shard:Number(shard),size:Number(size),onProgress:checkpoint});
await checkpoint(result);
