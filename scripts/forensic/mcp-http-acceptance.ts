/** Explicit local fixture only. Checkpoint each call; failed shards retain honest partial evidence. */
import {writeFile,rename,readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {runMcpHttpAcceptance,runMcpReadAcceptance} from '../../tests/integration/mcp-http/fixtures';
import {acceptanceCases,aggregateCoverage,type GatePhase} from '../../tests/integration/mcp-http/contractCases';
import {createHash} from 'node:crypto';
import type {Contract} from '../../tests/integration/mcp-http/contractSamples';
const [output,phase,shard='0',size='500']=process.argv.slice(2);
if(!output)throw new Error('Usage: bun scripts/forensic/mcp-http-acceptance.ts <evidence.json> [fields|scope|post|current|all|reads] [shard] [size<=600]');
if(phase&&!['all','fields','scope','post','current','reads','aggregate'].includes(phase))throw new Error('Invalid phase');
const target=resolve(output);
async function checkpoint(evidence:unknown){
 const temporary=`${target}.partial`;await writeFile(temporary,`${JSON.stringify(evidence,null,2)}\n`,{mode:0o600});await rename(temporary,target);
}
let result:unknown;
if(phase==='aggregate'){
 const inventory=JSON.parse(await readFile('docs/superpowers/plans/forensic-evidence/tool-contract-current.json','utf8')) as {tools:Contract[]};
 const cases=acceptanceCases(inventory.tools),hash=createHash('sha256').update(JSON.stringify(cases)).digest('hex');
 const paths=process.argv.slice(4);if(!paths.length)throw new Error('Aggregate requires evidence paths');
 const reports=await Promise.all(paths.map(async path=>JSON.parse(await readFile(path,'utf8')) as unknown));
 result=aggregateCoverage(cases,hash,reports);
}else result=phase==='reads'?await runMcpReadAcceptance(process.env):await runMcpHttpAcceptance(process.env,{phase:phase&&phase!=='all'?phase as GatePhase:undefined,shard:Number(shard),size:Number(size),onProgress:checkpoint});
await checkpoint(result);
