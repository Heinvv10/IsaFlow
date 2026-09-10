import {createHash} from 'node:crypto';
import {setImmediate} from 'node:timers/promises';
import {canonicalJson} from './canonical';
import {AUDIT_JOB_LIMITS} from './auditJobContract';
export const COMPARISON_SECTIONS=['records','checks','evidence','evidenceGaps'] as const;
export type ComparisonSection=typeof COMPARISON_SECTIONS[number];
export type ComparisonIdentity={source:string;id:string}|{checkId:string}|{id:string};
export interface ComparisonItem {identity:ComparisonIdentity;materialHash:string;ordinal:number}
interface SectionInput {count:number;items:AsyncIterable<ComparisonItem>}
export interface ComparisonSource {
 companyId:string;id:string;canonicalHash:string;cutoff:string;capturedAt:string;populationsHash:string;coverageHash:string;
 sections:Record<ComparisonSection,SectionInput>;
}
export interface ComparisonReference {snapshotId:string;canonicalHash:string;ordinal:number;materialHash:string}
export interface ComparisonChange {section:ComparisonSection;kind:'added'|'removed'|'changed';identity:ComparisonIdentity;before:ComparisonReference|null;after:ComparisonReference|null}
export interface ComparisonCounts {first:number;second:number;added:number;removed:number;changed:number;unchanged:number}
export interface ComparisonOptions {signal?:AbortSignal;deadlineAt?:number}
const digest=(value:unknown)=>createHash('sha256').update(canonicalJson(value)).digest('hex');
const HASH=/^[a-f0-9]{64}$/;
function record(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid comparison material');return value as Record<string,unknown>;}
function identityFor(section:ComparisonSection,value:Record<string,unknown>):ComparisonIdentity{
 const text=(key:string)=>{const v=value[key];if(typeof v!=='string'||!v)throw new Error('Invalid comparison identity');return v;};
 return section==='records'?{source:text('source'),id:text('id')}:section==='checks'?{checkId:text('checkId')}:{id:text('id')};
}
/** Projection producer helper. Authentication of the source is the caller's responsibility. */
export function makeComparisonItem(section:ComparisonSection,input:unknown,ordinal:number):ComparisonItem{
 if(!COMPARISON_SECTIONS.includes(section)||!Number.isSafeInteger(ordinal)||ordinal<0)throw new Error('Invalid comparison ordinal');
 const value=record(JSON.parse(canonicalJson(input)));
 const material=section==='checks'?Object.fromEntries(Object.entries(value).filter(([key])=>key!=='capturedAt')):value;
 return{identity:identityFor(section,value),materialHash:digest(material),ordinal};
}
function budget(options:ComparisonOptions){
 if(options.deadlineAt!==undefined&&!Number.isFinite(options.deadlineAt))throw new Error('Invalid comparison deadline');
 const check=()=>{options.signal?.throwIfAborted();if(options.deadlineAt!==undefined&&Date.now()>=options.deadlineAt)throw new Error('Comparison deadline exceeded');};
 async function wait<T>(pending:Promise<T>):Promise<T>{
  check();if(!options.signal&&options.deadlineAt===undefined)return pending;
  return new Promise<T>((resolve,reject)=>{
   let timer:ReturnType<typeof setTimeout>|undefined;
   const cleanup=()=>{if(timer)clearTimeout(timer);options.signal?.removeEventListener('abort',abort);};
   const abort=()=>{cleanup();reject(options.signal?.reason??new Error('Comparison aborted'));};
   options.signal?.addEventListener('abort',abort,{once:true});
   if(options.deadlineAt!==undefined)timer=setTimeout(()=>{cleanup();reject(new Error('Comparison deadline exceeded'));},Math.max(0,options.deadlineAt-Date.now()));
   pending.then(value=>{cleanup();resolve(value);},error=>{cleanup();reject(error);});
   if(options.signal?.aborted)abort();
  });
 }
 return{check,wait,expired:()=>options.signal?.aborted===true||(options.deadlineAt!==undefined&&Date.now()>=options.deadlineAt)};
}
function capture(source:ComparisonSource){
 const {sections,...metadata}=source,header=JSON.parse(canonicalJson(metadata)) as Omit<ComparisonSource,'sections'>;
 if(!header.companyId||!header.id||!HASH.test(header.canonicalHash)||!HASH.test(header.populationsHash)||!HASH.test(header.coverageHash))throw new Error('Invalid comparison source identity');
 const captured={} as Record<ComparisonSection,SectionInput>;
 for(const section of COMPARISON_SECTIONS){const {count,items}=sections[section];
  if(!Number.isSafeInteger(count)||count<0||count>(section==='checks'?6:AUDIT_JOB_LIMITS.maxRecords)||typeof items?.[Symbol.asyncIterator]!=='function')throw new Error('Invalid comparison section count');
  captured[section]={count,items};
 }
 if(captured.evidence.count+captured.evidenceGaps.count>AUDIT_JOB_LIMITS.maxRecords)throw new Error('Invalid comparison evidence population');
 return{...header,sections:captured};
}
/**
 * Authenticated projections enter here; this pure function does not authenticate ciphertext.
 * It retains two current items and ordinal bitsets, never full source material or output lists.
 * Emitted rows are provisional until this function returns its reconciled summary successfully.
 */
export async function compareSnapshotStreams(inputFirst:ComparisonSource,inputSecond:ComparisonSource,emit:(change:ComparisonChange)=>Promise<void>,options:ComparisonOptions={}){
 const clock=budget(options);clock.check();const first=capture(inputFirst),second=capture(inputSecond);
 if(first.companyId!==second.companyId)throw new Error('Comparison source companies differ');
 const counts={} as Record<ComparisonSection,ComparisonCounts>;let consumed=0;
 for(const section of COMPARISON_SECTIONS){
  const left=first.sections[section],right=second.sections[section],a=left.items[Symbol.asyncIterator](),b=right.items[Symbol.asyncIterator]();
  const stats:ComparisonCounts={first:0,second:0,added:0,removed:0,changed:0,unchanged:0};counts[section]=stats;
  const states=[{input:left,iterator:a,count:0,key:'',seen:new Uint8Array(Math.ceil(left.count/8))},{input:right,iterator:b,count:0,key:'',seen:new Uint8Array(Math.ceil(right.count/8))}];
  async function next(side:number):Promise<ComparisonItem|null>{
   clock.check();const state=states[side]!,step=await clock.wait(Promise.resolve().then(()=>state.iterator.next()));clock.check();
   if(step.done){if(state.count!==state.input.count)throw new Error('Comparison source count mismatch');return null;}
   const row=record(JSON.parse(canonicalJson(step.value))),identity=identityFor(section,record(row.identity));
   if(Object.keys(row).sort().join(',')!=='identity,materialHash,ordinal'||canonicalJson(identity)!==canonicalJson(row.identity)
    ||typeof row.materialHash!=='string'||!HASH.test(row.materialHash)||typeof row.ordinal!=='number'||!Number.isSafeInteger(row.ordinal)||row.ordinal<0||row.ordinal>=state.input.count)throw new Error('Invalid comparison item');
   const key=canonicalJson(identity),slot=Math.floor(row.ordinal/8),bit=1<<(row.ordinal%8);
   if((state.count>0&&key<=state.key)||(state.seen[slot]!&bit)!==0||state.count>=state.input.count)throw new Error('Duplicate or unordered comparison source');
   state.seen[slot]=state.seen[slot]!|bit;state.key=key;state.count++;consumed++;
   if(consumed%64===0){await clock.wait(setImmediate());clock.check();}
   return{identity,materialHash:row.materialHash,ordinal:row.ordinal};
  }
  const ref=(source:typeof first,item:ComparisonItem):ComparisonReference=>({snapshotId:source.id,canonicalHash:source.canonicalHash,ordinal:item.ordinal,materialHash:item.materialHash});
  let failed=false;
  try{
   let old=await next(0),current=await next(1);
   while(old||current){clock.check();const beforeKey=old?canonicalJson(old.identity):null,afterKey=current?canonicalJson(current.identity):null;
    if(old&&(!current||beforeKey!<afterKey!)){
     stats.removed++;await clock.wait(Promise.resolve().then(()=>emit({section,kind:'removed',identity:old!.identity,before:ref(first,old!),after:null})));old=await next(0);
    }else if(current&&(!old||afterKey!<beforeKey!)){
     stats.added++;await clock.wait(Promise.resolve().then(()=>emit({section,kind:'added',identity:current!.identity,before:null,after:ref(second,current!)})));current=await next(1);
    }else{
     if(old!.materialHash!==current!.materialHash){stats.changed++;await clock.wait(Promise.resolve().then(()=>emit({section,kind:'changed',identity:current!.identity,before:ref(first,old!),after:ref(second,current!)})));}
     else stats.unchanged++;
     old=await next(0);current=await next(1);
    }
   }
   stats.first=states[0]!.count;stats.second=states[1]!.count;
   if(stats.first!==stats.removed+stats.changed+stats.unchanged||stats.second!==stats.added+stats.changed+stats.unchanged)throw new Error('Comparison counts do not reconcile');
  }catch(error){failed=true;throw error;}
  finally{
   const closing=Promise.allSettled([Promise.resolve().then(()=>a.return?.()),Promise.resolve().then(()=>b.return?.())]);
   // A stalled provider cannot extend an expired deadline. Its owner must cancel its underlying I/O.
   if(!clock.expired()){
    const results=await clock.wait(closing),errors=results.filter((row):row is PromiseRejectedResult=>row.status==='rejected');
    if(errors.length&&!failed)throw new AggregateError(errors.map(row=>row.reason),'Comparison iterator cleanup failed');
   }
  }
 }
 clock.check();const metadata=(source:typeof first)=>({id:source.id,cutoff:source.cutoff,capturedAt:source.capturedAt,canonicalHash:source.canonicalHash});
 return{first:metadata(first),second:metadata(second),counts,populationChanged:first.populationsHash!==second.populationsHash,coverageChanged:first.coverageHash!==second.coverageHash};
}
