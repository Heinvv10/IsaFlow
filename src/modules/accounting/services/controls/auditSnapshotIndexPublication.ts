import type {ControlTx} from './contracts';
import {assertAuditJobLease,type AuditJobLease} from './auditJobLease';
import {assertEffectivePermission} from '@/lib/auth/effectivePermissions';
import {loadStoredAuditJobDelegation} from './auditJobDelegation';
import {verifyAuditSnapshot,type SealedAuditSnapshot} from './auditSnapshotSeal';
import {assertSnapshotRequest,type SnapshotArtifactBytes} from './auditSnapshotPublicationMaterial';
import {buildSnapshotIndex} from './auditSnapshotIndexMaterial';
import {indexBudget} from './auditSnapshotIndexValidation';
import type {SnapshotIndexMaterial} from './auditSnapshotIndexContract';
/** Batches cap both row count and encoded parameter bytes; large items never become a single giant INSERT. */
async function writeRows(ctx:ControlTx,lease:AuditJobLease,kind:'item'|'chunk',rows:Iterable<Record<string,unknown>>,check:()=>void){
 let batch:string[]=[],bytes=0;
 async function flush(){
  if(!batch.length)return;check();const encoded='['+batch.join(',')+']';
  if(kind==='item')await ctx.sql`INSERT INTO control_audit_snapshot_index_items(company_id,snapshot_id,section,ordinal,protected_item)
   SELECT ${lease.companyId}::uuid,${lease.jobId}::uuid,x.section,x.ordinal,x.envelope
   FROM jsonb_to_recordset(${encoded}::jsonb) AS x(section text,ordinal integer,envelope jsonb)`;
  else await ctx.sql`INSERT INTO control_audit_snapshot_index_chunks(company_id,snapshot_id,section,ordinal,chunk_ordinal,protected_chunk)
   SELECT ${lease.companyId}::uuid,${lease.jobId}::uuid,x.section,x.ordinal,x.chunk_ordinal,x.envelope
   FROM jsonb_to_recordset(${encoded}::jsonb) AS x(section text,ordinal integer,chunk_ordinal integer,envelope jsonb)`;
  check();batch=[];bytes=0;
 }
 for(const row of rows){
  check();const encoded=JSON.stringify(row),size=Buffer.byteLength(encoded)+1;
  if(size>2*1024*1024)throw new Error('Snapshot index SQL row resource limit');
  if(batch.length>=512||bytes+size>2*1024*1024)await flush();batch.push(encoded);bytes+=size;
 }
 await flush();
}
function* itemRows(material:SnapshotIndexMaterial){for(const item of material.items)yield{section:item.section,ordinal:item.ordinal,envelope:item.protectedItem};}
function* chunkRows(material:SnapshotIndexMaterial){for(const item of material.items)for(const [chunk_ordinal,envelope] of item.chunks.entries())yield{section:item.section,ordinal:item.ordinal,chunk_ordinal,envelope};}
/** Called inside the snapshot publication savepoint before its lease-fenced success update. */
export async function publishSnapshotIndex(ctx:ControlTx,lease:AuditJobLease,sealed:SealedAuditSnapshot,artifacts:readonly SnapshotArtifactBytes[],options?:{signal?:AbortSignal;deadlineAt?:number}){
 assertAuditJobLease(ctx,lease);
 if(ctx.principal.authMethod!=='job'||ctx.principal.jobId!==lease.jobId||ctx.principal.jobLeaseId!==lease.leaseId||ctx.principal.jobGeneration!==lease.generation)throw new Error('Index publication requires delegated worker authority');
 const check=indexBudget(options);check();
 const saved=await loadStoredAuditJobDelegation(ctx.sql,lease.companyId,lease.personId,lease);
 for(const permission of saved.permissions)await assertEffectivePermission(ctx,permission);
 const snapshot=verifyAuditSnapshot(sealed,{companyId:lease.companyId,snapshotId:lease.jobId});assertSnapshotRequest(snapshot,saved.request);
 const material=await buildSnapshotIndex(sealed,artifacts,saved.permissions,options);check();
 await ctx.sql`INSERT INTO control_audit_snapshot_indexes(company_id,snapshot_id,protected_header)
  VALUES(${lease.companyId}::uuid,${lease.jobId}::uuid,${JSON.stringify(material.protectedHeader)}::jsonb)`;
 await writeRows(ctx,lease,'item',itemRows(material),check);await writeRows(ctx,lease,'chunk',chunkRows(material),check);
 return material.header;
}
