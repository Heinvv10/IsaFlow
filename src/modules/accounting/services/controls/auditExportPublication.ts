import {withSavepoint} from '@/lib/neon';
import {assertEffectivePermission} from '@/lib/auth/effectivePermissions';
import type {ControlTx} from './contracts';
import {assertAuditJobLease,type AuditJobLease} from './auditJobLease';
import {loadStoredAuditJobDelegation} from './auditJobDelegation';
import {readAuditSnapshotIndexHeader} from './auditSnapshotIndexRead';
import {exportDeliveryRows} from './auditExportDeliveryMaterial';
import {indexBudget} from './auditSnapshotIndexValidation';
import type {AuditEvidenceBundle,ExportOptions} from './auditEvidenceExportMaterial';
/** All authenticated files and chunks commit with the exact generation's success marker. */
export async function publishAuditExport(ctx:ControlTx,lease:AuditJobLease,bundle:AuditEvidenceBundle,options:ExportOptions={}){
 assertAuditJobLease(ctx,lease);
 if(ctx.principal.authMethod!=='job'||ctx.principal.jobId!==lease.jobId||ctx.principal.jobLeaseId!==lease.leaseId||ctx.principal.jobGeneration!==lease.generation)
  throw new Error('Export publication requires the original delegated job context');
 const check=indexBudget(options);check();
 return withSavepoint('audit_export_publish',async()=>{
  const saved=await loadStoredAuditJobDelegation(ctx.sql,lease.companyId,lease.personId,lease);
  if(saved.kind!=='audit_export')throw new Error('Export publication requires export job kind');
  for(const permission of saved.permissions)await assertEffectivePermission(ctx,permission);
  const index=await readAuditSnapshotIndexHeader(ctx,saved.request.snapshotId);
  if(index.canonicalHash!==saved.request.canonicalSnapshotHash||index.permissions.join(',')!==saved.permissions.join(','))throw new Error('Export source identity changed');
  const identity={companyId:lease.companyId,jobId:lease.jobId,leaseId:lease.leaseId,generation:lease.generation,
   snapshotId:saved.request.snapshotId,canonicalSnapshotHash:saved.request.canonicalSnapshotHash};
  let header:string|undefined;
  for await(const row of exportDeliveryRows(bundle,identity,saved.permissions,options)){
   check();const encoded=JSON.stringify(row.envelope);
   if(row.kind==='header')header=encoded;
   else if(row.kind==='file')await ctx.sql`INSERT INTO control_audit_export_files(company_id,job_id,generation,lease_id,file_ordinal,protected_file)
    VALUES(${lease.companyId}::uuid,${lease.jobId}::uuid,${lease.generation},${lease.leaseId}::uuid,${row.file.ordinal},${encoded}::jsonb)`;
   else await ctx.sql`INSERT INTO control_audit_export_chunks(company_id,job_id,generation,lease_id,file_ordinal,chunk_ordinal,protected_chunk)
    VALUES(${lease.companyId}::uuid,${lease.jobId}::uuid,${lease.generation},${lease.leaseId}::uuid,${row.fileOrdinal},${row.chunkOrdinal},${encoded}::jsonb)`;
  }
  check();if(!header)throw new Error('Export material is incomplete');
  await ctx.sql`INSERT INTO control_audit_export_results(company_id,job_id,generation,lease_id,protected_header)
   VALUES(${lease.companyId}::uuid,${lease.jobId}::uuid,${lease.generation},${lease.leaseId}::uuid,${header}::jsonb)`;
  const rows=await ctx.sql`UPDATE control_audit_jobs SET state='succeeded',result_export_id=${lease.jobId}::uuid,
   lease_id=NULL,lease_expires_at=NULL,last_error_code=NULL,completed_at=clock_timestamp(),updated_at=clock_timestamp()
   WHERE company_id=${lease.companyId}::uuid AND job_id=${lease.jobId}::uuid AND state='running'
    AND lease_id=${lease.leaseId}::uuid AND generation=${lease.generation} AND lease_expires_at>clock_timestamp() RETURNING job_id`;
  if(rows.length!==1)throw new Error('Export publication lease expired or was replaced');
  check();return{exportId:lease.jobId,canonicalHash:saved.request.canonicalSnapshotHash};
 });
}
