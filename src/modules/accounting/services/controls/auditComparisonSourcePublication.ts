import {readRetainedAuditSnapshotSeal} from './auditRetainedSnapshotSeal';
import {readAuditComparisonInputs} from './auditComparisonInputs';
import {readComparisonSourceHeader} from './auditComparisonSourceRead';
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
 await retainMaterial(ctx,lease,lease.jobId,material,check);
}
async function retainMaterial(ctx:ControlTx,lease:AuditJobLease,snapshotId:string,material:Awaited<ReturnType<typeof sealComparisonSource>>,check:()=>void){
 const header=await ctx.sql`INSERT INTO control_audit_comparison_sources(company_id,snapshot_id,build_job_id,build_generation,build_lease_id,protected_header)
  VALUES(${lease.companyId}::uuid,${snapshotId}::uuid,${lease.jobId}::uuid,${lease.generation},${lease.leaseId}::uuid,${JSON.stringify(material.protectedHeader)}::jsonb)
  RETURNING company_id,snapshot_id` as {company_id:string;snapshot_id:string}[];
 if(header.length!==1||header[0]?.company_id!==lease.companyId||header[0].snapshot_id!==snapshotId)throw new Error('Comparison source header retention failed');
 let batch:typeof material.items=[],bytes=0;
 async function flush(){
  if(!batch.length)return;check();
  const encoded=JSON.stringify(batch.map(row=>({section:row.section,position:row.position,envelope:row.protectedItem})));
  const rows=await ctx.sql`INSERT INTO control_audit_comparison_source_items(company_id,snapshot_id,build_job_id,build_generation,build_lease_id,section,position,protected_item)
   SELECT ${lease.companyId}::uuid,${snapshotId}::uuid,${lease.jobId}::uuid,${lease.generation},${lease.leaseId}::uuid,x.section,x.position,x.envelope
   FROM jsonb_to_recordset(${encoded}::jsonb) AS x(section text,position integer,envelope jsonb)
   RETURNING company_id,snapshot_id,section,position` as {company_id:string;snapshot_id:string;section:string;position:number}[];
  const expected=new Set(batch.map(row=>`${row.section}:${row.position}`));
  if(rows.length!==batch.length||rows.some(row=>row.company_id!==lease.companyId||row.snapshot_id!==snapshotId||!expected.delete(`${row.section}:${row.position}`))||expected.size)throw new Error('Comparison source item retention failed');
  check();batch=[];bytes=0;
 }
 for(const row of material.items){
  check();const size=Buffer.byteLength(JSON.stringify({section:row.section,position:row.position,envelope:row.protectedItem}))+1;
  if(size>2097150)throw new Error('Comparison source SQL row resource limit');
  if(batch.length>=256||bytes+size>2097150)await flush();batch.push(row);bytes+=size;
 }
 await flush();check();
}
/** Legacy conversion is background-only and retains one original seal at a time; reads never trigger it. */
export async function ensureComparisonSource(ctx:ControlTx,lease:AuditJobLease,snapshotId:string,options?:ComparisonOptions){
 assertAuditJobLease(ctx,lease);
 if(ctx.principal.authMethod!=='job'||ctx.principal.jobId!==lease.jobId||ctx.principal.jobLeaseId!==lease.leaseId
  ||ctx.principal.jobGeneration!==lease.generation)throw new Error('Comparison conversion requires original delegated worker authority');
 const check=indexBudget(options);check();
 const saved=await loadStoredAuditJobDelegation(ctx.sql,lease.companyId,lease.personId,lease);
 if(saved.kind!=='audit_compare')throw new Error('Comparison conversion requires comparison job kind');
 const inputs=await readAuditComparisonInputs(ctx,saved.request);
 const original=snapshotId===saved.request.firstSnapshotId?inputs.first:snapshotId===saved.request.secondSnapshotId?inputs.second:null;
 if(!original)throw new Error('Comparison conversion source differs from request');
 const existing=await ctx.sql`SELECT snapshot_id FROM control_audit_comparison_sources WHERE company_id=${lease.companyId}::uuid AND snapshot_id=${snapshotId}::uuid`;
 if(existing.length>1)throw new Error('Comparison source identity is ambiguous');
 if(!existing.length){
  const {sealed}=await readRetainedAuditSnapshotSeal(ctx,snapshotId);check();
  if(sealed.canonicalHash!==original.canonicalHash)throw new Error('Comparison legacy source hash changed');
  const material=await sealComparisonSource(sealed,{companyId:lease.companyId,snapshotId},original.permissions,options);check();
  try{await retainMaterial(ctx,lease,snapshotId,material,check);}
  catch(error){
   // Another comparison can complete the same immutable legacy projection first. Retry the entire repeatable-read attempt.
   if(error&&typeof error==='object'&&'code'in error&&error.code==='23505'&&'constraint'in error&&error.constraint==='control_audit_comparison_sources_pkey'){
    throw Object.assign(new Error('Concurrent comparison source publication requires retry'),{code:'40001'});
   }
   throw error;
  }
 }
 check();return readComparisonSourceHeader(ctx,snapshotId,original.canonicalHash);
}
