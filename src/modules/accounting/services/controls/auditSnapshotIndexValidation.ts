import {z} from 'zod';
import {canonicalJson} from './canonical';
import type {AuditSnapshotData} from './auditSnapshotSeal';
import {parseAuditSnapshotRequest,auditSnapshotPermissions,type AuditSnapshotRequest} from './auditJobContract';
import {assertSnapshotRequest} from './auditSnapshotPublicationMaterial';
import {SNAPSHOT_INDEX_LIMITS,SNAPSHOT_INDEX_SECTIONS} from './auditSnapshotIndexContract';
const hash=z.string().regex(/^[a-f0-9]{64}$/);
export const indexIdentity=z.object({companyId:z.string().uuid(),snapshotId:z.string().uuid(),canonicalHash:hash});
const count=z.number().int().nonnegative().max(SNAPSHOT_INDEX_LIMITS.maxItems);
// An evidence item can combine the entire supported metadata budget and the retained-byte base64 budget.
const maxItemBytes=100*1024*1024+Math.ceil(100*1024*1024/3)*4+1024;
export const indexHeader=indexIdentity.extend({version:z.literal(1),permissions:z.array(z.string()).max(4),
 counts:z.object({records:count,checks:count,findings:count,evidence:count,gaps:count}).strict()}).strict()
 .refine(value=>Object.values(value.counts).reduce((sum,n)=>sum+n,0)<=SNAPSHOT_INDEX_LIMITS.maxItems,'Index item resource limit');
export const indexItem=indexIdentity.extend({section:z.enum(SNAPSHOT_INDEX_SECTIONS),ordinal:count,
 byteLength:z.number().int().positive().max(maxItemBytes),sha256:hash,
 chunkCount:z.number().int().positive().max(Math.ceil(maxItemBytes/SNAPSHOT_INDEX_LIMITS.chunkBytes))}).strict()
 .refine(value=>value.chunkCount===Math.ceil(value.byteLength/SNAPSHOT_INDEX_LIMITS.chunkBytes),'Invalid index chunk count');
export const chunkSchema=z.object({item:indexItem,chunkOrdinal:z.number().int().nonnegative(),bytesBase64:z.string().max(349528)}).strict();
export function detachIndexValue<T>(value:T):T{return JSON.parse(canonicalJson(value)) as T;}
export function deriveIndexPermissions(snapshot:AuditSnapshotData,provided:string[]):string[]{
 const anchors:Record<string,AuditSnapshotRequest['sources'][number]>={journal_entry:'journals',customer_invoice:'ar',supplier_invoice:'ap',sage_supplier_invoice:'ap',bank_transaction:'bank',payroll_run:'payroll'};
 const sources=[...new Set(snapshot.populations.flatMap(population=>anchors[population.source]?[anchors[population.source]!]:[]))];
 const request=parseAuditSnapshotRequest({cutoff:snapshot.cutoff,sources,checks:snapshot.checks.map(check=>check.checkId),idempotencyKey:'retained-index'});
 assertSnapshotRequest(snapshot,request,'retained');
 const derived=auditSnapshotPermissions(request),supplied=z.array(z.string()).max(4).parse(detachIndexValue(provided));
 if(canonicalJson([...supplied].sort())!==canonicalJson(derived))throw new Error('Snapshot index permissions differ from authenticated sources');
 return derived;
}
/** Detach options without invoking caller getters; native AbortSignal state is read through its intrinsic accessor. */
export function indexBudget(options?:{signal?:AbortSignal;deadlineAt?:number}){
 let signal:AbortSignal|undefined,deadlineAt=Date.now()+60000;
 if(options!==undefined){
  if(!options||typeof options!=='object'||Reflect.ownKeys(options).some(key=>key!=='signal'&&key!=='deadlineAt'))throw new Error('Invalid index options');
  const fields=Object.getOwnPropertyDescriptors(options);
  for(const key of ['signal','deadlineAt'])if(fields[key]&&!('value'in fields[key]!))throw new Error('Invalid index options');
  signal=fields.signal?.value as AbortSignal|undefined;
  if(signal!==undefined&&!(signal instanceof AbortSignal))throw new Error('Invalid index abort signal');
  const requested:unknown=fields.deadlineAt?.value;
  if(requested!==undefined){if(typeof requested!=='number'||!Number.isFinite(requested))throw new Error('Invalid index deadline');deadlineAt=Math.min(deadlineAt,requested);}
 }
 const aborted=Object.getOwnPropertyDescriptor(AbortSignal.prototype,'aborted')!.get!;
 return()=>{if(signal&&aborted.call(signal))throw new Error('Snapshot index aborted');if(Date.now()>deadlineAt)throw new Error('Snapshot index deadline exceeded');};
}
