import {publishSnapshotIndex} from './auditSnapshotIndexPublication';
import {withSavepoint} from '@/lib/neon';
import {UUID_RE} from '@/lib/validation';
import {assertEffectivePermission} from '@/lib/auth/effectivePermissions';
import {assertControlTx} from './context';
import type {ControlTx} from './contracts';
import {assertAuditJobLease,type AuditJobLease} from './auditJobLease';
import {loadStoredAuditJobDelegation} from './auditJobDelegation';
import {openAuditJobRequest} from './auditJobProtection';
import {auditSnapshotPermissions} from './auditJobContract';
import {sealAuditSnapshot,verifyAuditSnapshot,type SealedAuditSnapshot} from './auditSnapshotSeal';
import {openProtectedChange,protectChangeValues,type ProtectedChange} from './changeProtection';
import {assertSnapshotArtifacts,assertSnapshotRequest,copySnapshotArtifacts,type SnapshotArtifactBytes} from './auditSnapshotPublicationMaterial';

/** Worker publication is one transaction: no success without every authenticated retained byte. */
export async function publishAuditSnapshot(ctx:ControlTx,lease:AuditJobLease,input:SealedAuditSnapshot,sourceArtifacts:readonly SnapshotArtifactBytes[],options?:{signal?:AbortSignal;deadlineAt?:number}){
 assertAuditJobLease(ctx,lease);
 if(ctx.principal.authMethod!=='job'||ctx.principal.jobId!==lease.jobId||ctx.principal.jobLeaseId!==lease.leaseId
  ||ctx.principal.jobGeneration!==lease.generation)throw new Error('Snapshot publication requires the original delegated job context');
 const snapshot=verifyAuditSnapshot(input,{companyId:ctx.principal.companyId,snapshotId:lease.jobId});
 const sealed=sealAuditSnapshot(snapshot),artifacts=copySnapshotArtifacts(sourceArtifacts);
 assertSnapshotArtifacts(snapshot,artifacts);
 return withSavepoint('audit_snapshot_publish',async()=>{
  const saved=await loadStoredAuditJobDelegation(ctx.sql,lease.companyId,lease.personId,lease);
  for(const permission of saved.permissions)await assertEffectivePermission(ctx,permission);
  assertSnapshotRequest(snapshot,saved.request);
  const protectedSnapshot=protectChangeValues('audit_snapshot',null,{companyId:lease.companyId,snapshotId:lease.jobId,jobId:lease.jobId,sealed}).protectedPayload;
  await ctx.sql`INSERT INTO control_audit_snapshots(company_id,id,job_id,requester_person_id,cutoff,canonical_hash,protected_snapshot)
   VALUES(${lease.companyId}::uuid,${lease.jobId}::uuid,${lease.jobId}::uuid,${lease.personId},${snapshot.cutoff}::date,${sealed.canonicalHash},${JSON.stringify(protectedSnapshot)}::jsonb)`;
  for(const artifact of artifacts){
   const protectedArtifact=protectChangeValues('audit_snapshot_artifact',null,{companyId:lease.companyId,snapshotId:lease.jobId,
    artifactId:artifact.id,bytes:Buffer.from(artifact.bytes).toString('base64')}).protectedPayload;
   await ctx.sql`INSERT INTO control_audit_snapshot_artifacts(company_id,snapshot_id,artifact_id,protected_artifact)
    VALUES(${lease.companyId}::uuid,${lease.jobId}::uuid,${artifact.id},${JSON.stringify(protectedArtifact)}::jsonb)`;
  }
  await publishSnapshotIndex(ctx,lease,sealed,artifacts,options);
  const rows=await ctx.sql`UPDATE control_audit_jobs SET state='succeeded',result_snapshot_id=${lease.jobId}::uuid,
   lease_id=NULL,lease_expires_at=NULL,last_error_code=NULL,completed_at=clock_timestamp(),updated_at=clock_timestamp()
   WHERE company_id=${lease.companyId}::uuid AND job_id=${lease.jobId}::uuid AND state='running'
    AND lease_id=${lease.leaseId}::uuid AND generation=${lease.generation} AND lease_expires_at>clock_timestamp() RETURNING job_id`;
  if(rows.length!==1)throw new Error('Snapshot publication lease expired or was replaced');
  return{snapshotId:lease.jobId,canonicalHash:sealed.canonicalHash};
 });
}
/** Full retained load for bounded background comparison/export. Status and page routes must not call this. */
export async function readRetainedAuditSnapshot(ctx:ControlTx,id:string){
 assertControlTx(ctx);if(!UUID_RE.test(id))throw new Error('Invalid snapshot identity');
 await assertEffectivePermission(ctx,'read:reports');
 const rows=await ctx.sql`SELECT s.protected_snapshot,s.canonical_hash,i.id,i.company_id,i.requester_person_id,i.request_hash,i.protected_request
  FROM control_audit_snapshots s JOIN control_audit_job_intents i ON i.company_id=s.company_id AND i.id=s.job_id
  JOIN control_audit_jobs j ON j.company_id=s.company_id AND j.job_id=s.job_id AND j.state='succeeded' AND j.result_snapshot_id=s.id
  WHERE s.company_id=${ctx.principal.companyId}::uuid AND s.id=${id}::uuid` as {
   protected_snapshot:ProtectedChange;canonical_hash:string;id:string;company_id:string;requester_person_id:string;request_hash:string;protected_request:ProtectedChange}[];
 const row=rows[0];if(rows.length!==1||!row)throw new Error('Retained snapshot unavailable');
 const saved=openAuditJobRequest(row);
 for(const permission of auditSnapshotPermissions(saved.request))await assertEffectivePermission(ctx,permission);
 const retained=openProtectedChange(row.protected_snapshot).after;
 if(!retained||retained.companyId!==ctx.principal.companyId||retained.snapshotId!==id||retained.jobId!==row.id)throw new Error('Retained snapshot identity changed');
 const snapshot=verifyAuditSnapshot(retained.sealed as SealedAuditSnapshot,{companyId:ctx.principal.companyId,snapshotId:id});
 const sealed=sealAuditSnapshot(snapshot);
 if(sealed.canonicalHash!==row.canonical_hash)throw new Error('Retained snapshot hash changed');
 assertSnapshotRequest(snapshot,saved.request,'retained');
 const stored=await ctx.sql`SELECT artifact_id,protected_artifact FROM control_audit_snapshot_artifacts
  WHERE company_id=${ctx.principal.companyId}::uuid AND snapshot_id=${id}::uuid ORDER BY artifact_id LIMIT 100001` as {artifact_id:string;protected_artifact:ProtectedChange}[];
 const artifacts=stored.map(artifact=>{
  const body=openProtectedChange(artifact.protected_artifact).after;
  if(!body||body.companyId!==ctx.principal.companyId||body.snapshotId!==id||body.artifactId!==artifact.artifact_id||typeof body.bytes!=='string')throw new Error('Retained artifact identity changed');
  return{id:artifact.artifact_id,bytes:Buffer.from(body.bytes,'base64')};
 });
 const copied=copySnapshotArtifacts(artifacts);assertSnapshotArtifacts(snapshot,copied);
 return{snapshot,sealed,artifacts:copied};
}
