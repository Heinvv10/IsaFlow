import type {ControlTx} from './contracts';
import {assertAuditJobLease,type AuditJobLease} from './auditJobLease';
import {assertEffectivePermission} from '@/lib/auth/effectivePermissions';
import {loadStoredAuditJobDelegation} from './auditJobDelegation';
import {indexBudget} from './auditSnapshotIndexValidation';
import type {SnapshotIndexMaterial} from './auditSnapshotIndexContract';
type Row={section:string;ordinal:number;chunk_ordinal?:number;envelope:unknown};
type StoredRow={company_id:string;snapshot_id:string;section:string;ordinal:number;chunk_ordinal?:number};
const MAX_BYTES=2*1024*1024;
function identity(row:{section:string;ordinal:number;chunk_ordinal?:number}){return JSON.stringify([row.section,row.ordinal,row.chunk_ordinal??null]);}
async function writeRows(ctx:ControlTx,lease:AuditJobLease,snapshotId:string,kind:'item'|'chunk',rows:Iterable<Row>,check:()=>void){
 let batch:Row[]=[],encoded:string[]=[],bytes=2;
 async function flush(){
  if(!batch.length)return;check();const payload='['+encoded.join(',')+']';
  const returned=kind==='item'?await ctx.sql`INSERT INTO control_audit_snapshot_index_items(company_id,snapshot_id,section,ordinal,protected_item)
   SELECT ${lease.companyId}::uuid,${snapshotId}::uuid,x.section,x.ordinal,x.envelope
   FROM jsonb_to_recordset(${payload}::jsonb) AS x(section text,ordinal integer,envelope jsonb)
   RETURNING company_id,snapshot_id,section,ordinal`
   :await ctx.sql`INSERT INTO control_audit_snapshot_index_chunks(company_id,snapshot_id,section,ordinal,chunk_ordinal,protected_chunk)
   SELECT ${lease.companyId}::uuid,${snapshotId}::uuid,x.section,x.ordinal,x.chunk_ordinal,x.envelope
   FROM jsonb_to_recordset(${payload}::jsonb) AS x(section text,ordinal integer,chunk_ordinal integer,envelope jsonb)
   RETURNING company_id,snapshot_id,section,ordinal,chunk_ordinal`;
  const expected=new Set(batch.map(identity));
  if(returned.length!==batch.length||expected.size!==batch.length)throw new Error('Snapshot index retention incomplete');
  for(const row of returned as StoredRow[]){
   if(row.company_id!==lease.companyId||row.snapshot_id!==snapshotId||!expected.delete(identity(row)))throw new Error('Snapshot index retention identity mismatch');
  }
  check();batch=[];encoded=[];bytes=2;
 }
 for(const row of rows){
  check();const value=JSON.stringify(row),size=Buffer.byteLength(value);
  if(size+2>MAX_BYTES)throw new Error('Snapshot index SQL row resource limit');
  if(batch.length>=512||bytes+size+(batch.length?1:0)>MAX_BYTES)await flush();
  bytes+=size+(batch.length?1:0);batch.push(row);encoded.push(value);
 }
 await flush();
}
function* items(material:SnapshotIndexMaterial):Generator<Row>{for(const item of material.items)yield{section:item.section,ordinal:item.ordinal,envelope:item.protectedItem};}
function* chunks(material:SnapshotIndexMaterial):Generator<Row>{for(const item of material.items)for(const [chunk_ordinal,envelope] of item.chunks.entries())yield{section:item.section,ordinal:item.ordinal,chunk_ordinal,envelope};}
/** Caller owns the enclosing publication transaction/savepoint; no partial material may be committed on failure. */
export async function retainSnapshotIndexMaterial(ctx:ControlTx,lease:AuditJobLease,snapshotId:string,material:SnapshotIndexMaterial,options?:{signal?:AbortSignal;deadlineAt?:number}){
 assertAuditJobLease(ctx,lease);
 if(ctx.principal.authMethod!=='job'||ctx.principal.jobId!==lease.jobId||ctx.principal.jobLeaseId!==lease.leaseId||ctx.principal.jobGeneration!==lease.generation)throw new Error('Index retention requires delegated worker authority');
 const check=indexBudget(options);check();
 const saved=await loadStoredAuditJobDelegation(ctx.sql,lease.companyId,lease.personId,lease);
 if(saved.kind==='audit_snapshot'){
  if(snapshotId!==lease.jobId)throw new Error('Snapshot index target must equal snapshot job');
 }else if(saved.kind==='audit_compare'){
  if(snapshotId!==saved.request.firstSnapshotId&&snapshotId!==saved.request.secondSnapshotId)throw new Error('Snapshot index target is outside comparison inputs');
 }else throw new Error('Snapshot index retention requires snapshot or comparison job');
 for(const permission of saved.permissions)await assertEffectivePermission(ctx,permission);
 if(material.header.companyId!==lease.companyId||material.header.snapshotId!==snapshotId)throw new Error('Snapshot index material identity mismatch');
 check();
 const rows=await ctx.sql`INSERT INTO control_audit_snapshot_indexes(company_id,snapshot_id,protected_header,build_job_id,build_generation,build_lease_id)
  VALUES(${lease.companyId}::uuid,${snapshotId}::uuid,${JSON.stringify(material.protectedHeader)}::jsonb,${lease.jobId}::uuid,${lease.generation},${lease.leaseId}::uuid)
  RETURNING company_id,snapshot_id,build_job_id,build_generation,build_lease_id` as {company_id:string;snapshot_id:string;build_job_id:string;build_generation:string|number;build_lease_id:string}[];
 const row=rows[0];
 if(rows.length!==1||!row||row.company_id!==lease.companyId||row.snapshot_id!==snapshotId||row.build_job_id!==lease.jobId||Number(row.build_generation)!==lease.generation||row.build_lease_id!==lease.leaseId)throw new Error('Snapshot index header retention identity mismatch');
 await writeRows(ctx,lease,snapshotId,'item',items(material),check);
 await writeRows(ctx,lease,snapshotId,'chunk',chunks(material),check);check();
 return material.header;
}
