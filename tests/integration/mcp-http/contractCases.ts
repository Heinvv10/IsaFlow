import type {LocalBuild} from './client';
import {MCP_INPUT_COMPATIBILITY} from '@/lib/mcp/inputCompatibility';
import {contractSample,sample,type Contract,type Schema} from './contractSamples';
export interface ContractCase {id:string;args:Record<string,unknown>;kind:'refusal'|'compatibility';expected:string}
type Segment=string|number;
const clone=<T>(value:T):T=>structuredClone(value);
/** Independent expected messages: the production validator is never used as the case oracle. */
export function contractCases(tool:Contract):ContractCase[]{
 const rows:ContractCase[]=[],base=contractSample(tool),compat=MCP_INPUT_COMPATIBILITY[tool.name]??{};
 function add(path:Segment[],label:string,context:Record<string,unknown>,value:unknown,reason:string,accepted=false,remove=false){
  const args=clone(context);let owner:Record<string,unknown>|unknown[]=args;
  for(const segment of path.slice(0,-1))owner=(owner as Record<string,unknown>)[segment] as Record<string,unknown>;
  const key=path.at(-1)!;
  if(remove)delete (owner as Record<string,unknown>)[key];else(owner as Record<string,unknown>)[key]=value;
  const display=path.map((key,i)=>typeof key==='number'?`[${key}]`:`${i?'.':''}${key}`).join('');
  rows.push({id:`${tool.name}:${display||'$'}:${label}`,args,kind:accepted?'compatibility':'refusal',expected:tool.write&&display==='idempotency_key'&&(typeof value!=='string'||!value.trim())?'idempotency_key is required for write operations':`${display||'arguments'} ${reason}`});
 }
 function withValue(context:Record<string,unknown>,path:Segment[],value:unknown){
  const args=clone(context);let owner:Record<string,unknown>=args;
  for(const segment of path.slice(0,-1))owner=owner[segment] as Record<string,unknown>;
  owner[path.at(-1)!]=value;return args;
 }
 function walk(schema:Schema,path:Segment[],context:Record<string,unknown>){
  const types=Array.isArray(schema.type)?schema.type:[schema.type],keyPath=path.map(k=>typeof k==='number'?'*':k).join('.');
  if(path.length){
   const wrong=types.includes('object')?[]:{};
   add(path,'type',context,wrong,`must match type ${types.join(' or ')}`);
   if(compat.nullable?.includes(keyPath))add(path,'nullable',context,null,'',true);
   if(compat.numeric?.includes(keyPath))add(path,'numeric-string',context,String(sample(schema)),'',true);
   if(schema.enum){
    const wrongEnum=types.includes('string')?'__not_an_enum__':types.includes('boolean')?!schema.enum[0]:-987654321;
    add(path,'enum',context,wrongEnum,'must match an allowed value');
   }
   if(schema.format)add(path,'format',context,schema.format==='uuid'?'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx':'2026-02-30',schema.format==='uuid'?'must be a valid UUID':'must be a real YYYY-MM-DD date');
   if(schema.pattern)add(path,'pattern',context,'!'.repeat(Math.max(schema.minLength??1,1)),'must match the required pattern');
   if(schema.minLength&& !schema.enum)add(path,'minLength',context,'','is below minimum length');
   if(schema.maxLength!==undefined&&!schema.enum)add(path,'maxLength',context,'x'.repeat(schema.maxLength+1),'exceeds maximum length');
   for(const [bound,value,reason]of [['minimum',(schema.minimum??0)-1,'is below minimum'],['maximum',(schema.maximum??0)+1,'exceeds maximum'],['exclusiveMinimum',schema.exclusiveMinimum,'must exceed minimum']] as const){
    if(schema[bound]!==undefined)add(path,bound,context,value,reason,compat.clamped?.includes(keyPath));
   }
   if(types.includes('integer'))add(path,'fractional',context,1.5,`must match type ${types.join(' or ')}`,compat.clamped?.includes(keyPath));
  }
  if(types.includes('object')){
   const current=path.length?withValue(context,path,sample(schema)):context;
   add([...path,'forensic_untrusted_authority'],'unknown',current,true,'');
   rows.at(-1)!.expected=`${path.length?path.map((k,i)=>typeof k==='number'?`[${k}]`:`${i?'.':''}${k}`).join(''):'arguments'} contain unsupported properties`;
   for(const [key,child]of Object.entries(schema.properties??{})){
    if(schema.required?.includes(key))add([...path,key],'required',current,undefined,key==='idempotency_key'&&path.length===0&&tool.write?'is required for write operations':'is required',false,true);
    walk(child,[...path,key],current);
   }
  }
  if(types.includes('array')){
   if(!schema.items)throw new Error('Array without items');
   const child=sample(schema.items);
   if(schema.minItems)add(path,'minItems',context,[],'has too few items');
   if(schema.maxItems!==undefined){
    if(schema.maxItems>1000)throw new Error(`Explicit large array fixture required: ${tool.name}/${keyPath}`);
    add(path,'maxItems',context,Array.from({length:schema.maxItems+1},()=>clone(child)),'has too many items');
   }
   walk(schema.items,[...path,0],withValue(context,path,Array.from({length:Math.max(schema.minItems??1,1)},()=>clone(child))));
  }
 }
 walk(tool.input_schema,[],base);return rows;
}
export type GatePhase='fields'|'scope'|'post'|'current';
export interface AcceptanceCase {id:string;tool:string;phase:GatePhase;args:Record<string,unknown>;expected:string;exact:boolean}
export function acceptanceCases(tools:Contract[]):AcceptanceCase[]{
 const rows:AcceptanceCase[]=[];
 for(const tool of [...tools].sort((a,b)=>a.name.localeCompare(b.name))){
  for(const row of contractCases(tool).filter(row=>row.kind==='refusal'))rows.push({...row,tool:tool.name,phase:'fields',exact:true});
  const args=contractSample(tool);
  if(tool.scope)rows.push({id:`${tool.name}:scope`,tool:tool.name,phase:'scope',args,expected:`Insufficient scope: this tool requires ${tool.scope}`,exact:false});
  if(tool.requires_post)rows.push({id:`${tool.name}:post`,tool:tool.name,phase:'post',args,expected:'This operation posts irreversible entries and requires the write:post permission, which this connection was not granted.',exact:true});
  if(tool.scope)rows.push({id:`${tool.name}:current`,tool:tool.name,phase:'current',args,expected:'Current permissions do not allow this operation.',exact:true});
 }
 return rows;
}
export function selectShard<T>(cases:T[],shard:number,size:number):T[]{
 if(!Number.isSafeInteger(shard)||shard<0||!Number.isSafeInteger(size)||size<1||size>600)throw new Error('Invalid bounded shard');
 if(shard*size>=cases.length)throw new Error('Shard outside planned coverage');
 return cases.slice(shard*size,(shard+1)*size);
}
interface CaseIdentity {id:string;tool:string;phase:string}
export function aggregateCoverage(planned:CaseIdentity[],planHash:string,reports:unknown[]){
 const expected=new Map(planned.map(row=>[row.id,row])),seen=new Set<string>(),builds:LocalBuild[]=[];
 if(expected.size!==planned.length)throw new Error('Duplicate planned case IDs');
 for(const value of reports){
  const report=value as {outcome?:string;build?:LocalBuild;planHash?:string;executed?:Array<CaseIdentity&{committedRefusal?:boolean}>};
  if(!report||report.outcome!=='passed'||report.planHash!==planHash||!Array.isArray(report.executed))throw new Error('Aggregate plan mismatch');
  const build=report.build;
  if(!build||!/^[a-f0-9]{40}$/.test(build.commit)||!build.buildId||build.verification!=='local-process-cwd-artifact')throw new Error('Missing explicit build provenance');
  if(builds.some(prior=>prior.commit!==build.commit||prior.buildId!==build.buildId))throw new Error('Mixed-build aggregate');
  builds.push(build);
  for(const row of report.executed){
   const match=expected.get(row.id);
   if(!match||row.tool!==match.tool||row.phase!==match.phase||row.committedRefusal!==true)throw new Error('Unverified or mismatched aggregate case');
   seen.add(row.id);
  }
 }
 const remainingCaseIds=planned.filter(row=>!seen.has(row.id)).map(row=>row.id);
 return{planHash,buildProvenance:builds,plannedCaseCount:planned.length,executedCaseIds:planned.filter(row=>seen.has(row.id)).map(row=>row.id),remainingCaseIds,
  complete:remainingCaseIds.length===0,limitations:['Aggregate covers refusal gates only; safe read defaults and financial workflows are separate','No production verification']};
}
