import type {ControlTx} from './contracts';
import {assertAuditJobLease,type AuditJobLease} from './auditJobLease';
import {loadStoredAuditJobDelegation} from './auditJobDelegation';
import {assertEffectivePermission} from '@/lib/auth/effectivePermissions';
import {verifyAuditSnapshot,type SealedAuditSnapshot} from './auditSnapshotSeal';
import {assertSnapshotRequest} from './auditSnapshotPublicationMaterial';
import {sealComparisonSource} from './auditComparisonSourceProtection';
import {indexBudget} from './auditSnapshotIndexValidation';
import type {ComparisonOptions} from './auditSnapshotComparisonMaterial';
/** Same publication savepoint as original snapshot/index and the lease-fenced success pointer. */
export async function publishSnapshotComparisonSource(ctx:ControlTx,lease:AuditJobLease,sealed:SealedAuditSnapshot,options?:ComparisonOptions){
 assertAuditJobLease(ctx,lease);
 if(ctx.principal.authMethod!=='job'||ctx.principal.jobId!==lease.jobId||ctx.principal.jobLeaseId!==lease.leaseId
  ||ctx.principal.jobGeneration!==lease.generation)throw new Error('Comparison source publication requires original delegated worker authority');
 const check=indexBudget(options);check();
 const saved=await loadStoredAuditJobDelegation(ctx.sql,lease.companyId,lease.personId,lease);
 if(saved.kind!=='audit_snapshot')throw new Error('Snapshot comparison source requires snapshot job kind');
 for(const permission of saved.permissions)await assertEffectivePermission(ctx,permission);
 const snapshot=verifyAuditSnapshot(sealed,{companyId:lease.companyId,snapshotId:lease.jobId});assertSnapshotRequest(snapshot,saved.request);
 const material=await sealComparisonSource(sealed,{companyId:lease.companyId,snapshotId:lease.jobId},saved.permissions,options);check();
 const header=await ctx.sql`INSERT INTO control_audit_comparison_sources(company_id,snapshot_id,build_job_id,build_generation,build_lease_id,protected_header)
  VALUES(${lease.companyId}::uuid,${lease.jobId}::uuid,${lease.jobId}::uuid,${lease.generation},${lease.leaseId}::uuid,${JSON.stringify(material.protectedHeader)}::jsonb)
  RETURNING company_id,snapshot_id` as {company_id:string;snapshot_id:string}[];
 if(header.length!==1||header[0]?.company_id!==lease.companyId||header[0].snapshot_id!==lease.jobId)throw new Error('Comparison source header retention failed');
 let batch:typeof material.items=[],bytes=0;
 async function flush(){
  if(!batch.length)return;check();
  const encoded=JSON.stringify(batch.map(row=>({section:row.section,position:row.position,envelope:row.protectedItem})));
  const rows=await ctx.sql`INSERT INTO control_audit_comparison_source_items(company_id,snapshot_id,build_job_id,build_generation,build_lease_id,section,position,protected_item)
   SELECT ${lease.companyId}::uuid,${lease.jobId}::uuid,${lease.jobId}::uuid,${lease.generation},${lease.leaseId}::uuid,x.section,x.position,x.envelope
   FROM jsonb_to_recordset(${encoded}::jsonb) AS x(section text,position integer,envelope jsonb)
   RETURNING company_id,snapshot_id,section,position` as {company_id:string;snapshot_id:string;section:string;position:number}[];
  const expected=new Set(batch.map(row=>`${row.section}:${row.position}`));
  if(rows.length!==batch.length||rows.some(row=>row.company_id!==lease.companyId||row.snapshot_id!==lease.jobId||!expected.delete(`${row.section}:${row.position}`))||expected.size)throw new Error('Comparison source item retention failed');
  check();batch=[];bytes=0;
 }
 for(const row of material.items){
  check();const size=Buffer.byteLength(JSON.stringify({section:row.section,position:row.position,envelope:row.protectedItem}))+1;
  if(size>2097150)throw new Error('Comparison source SQL row resource limit');
  if(batch.length>=256||bytes+size>2097150)await flush();batch.push(row);bytes+=size;
 }
 await flush();check();
}
