import type {ControlTx} from './contracts';
import {assertAuditJobLease,type AuditJobLease} from './auditJobLease';
import {assertEffectivePermission} from '@/lib/auth/effectivePermissions';
import {loadStoredAuditJobDelegation} from './auditJobDelegation';
import {verifyAuditSnapshot,type SealedAuditSnapshot} from './auditSnapshotSeal';
import {assertSnapshotRequest,type SnapshotArtifactBytes} from './auditSnapshotPublicationMaterial';
import {buildSnapshotIndex} from './auditSnapshotIndexMaterial';
import {indexBudget} from './auditSnapshotIndexValidation';
import {retainSnapshotIndexMaterial} from './auditSnapshotIndexRows';
/** Called inside the snapshot publication savepoint before its lease-fenced success update. */
export async function publishSnapshotIndex(ctx:ControlTx,lease:AuditJobLease,sealed:SealedAuditSnapshot,artifacts:readonly SnapshotArtifactBytes[],options?:{signal?:AbortSignal;deadlineAt?:number}){
 assertAuditJobLease(ctx,lease);
 if(ctx.principal.authMethod!=='job'||ctx.principal.jobId!==lease.jobId||ctx.principal.jobLeaseId!==lease.leaseId||ctx.principal.jobGeneration!==lease.generation)throw new Error('Index publication requires delegated worker authority');
 const check=indexBudget(options);check();
 const saved=await loadStoredAuditJobDelegation(ctx.sql,lease.companyId,lease.personId,lease);
 if(saved.kind!=='audit_snapshot')throw new Error('Snapshot index publication requires snapshot job kind');
 for(const permission of saved.permissions)await assertEffectivePermission(ctx,permission);
 const snapshot=verifyAuditSnapshot(sealed,{companyId:lease.companyId,snapshotId:lease.jobId});assertSnapshotRequest(snapshot,saved.request);
 const material=await buildSnapshotIndex(sealed,artifacts,saved.permissions,options);check();
 return retainSnapshotIndexMaterial(ctx,lease,lease.jobId,material,options);
}
