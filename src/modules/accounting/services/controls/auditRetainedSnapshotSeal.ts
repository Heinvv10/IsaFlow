import {UUID_RE} from '@/lib/validation';
import {assertEffectivePermission} from '@/lib/auth/effectivePermissions';
import {assertControlTx} from './context';
import type {ControlTx} from './contracts';
import {openAuditJobRequest} from './auditJobProtection';
import {auditSnapshotPermissions} from './auditJobContract';
import {sealAuditSnapshot,verifyAuditSnapshot,type SealedAuditSnapshot} from './auditSnapshotSeal';
import {openProtectedChange,type ProtectedChange} from './changeProtection';
import {assertSnapshotRequest} from './auditSnapshotPublicationMaterial';
/** Background-only original seal load. Comparison needs authenticated metadata, never the binary artifact population. */
export async function readRetainedAuditSnapshotSeal(ctx:ControlTx,id:string){
 assertControlTx(ctx);if(!UUID_RE.test(id))throw new Error('Invalid snapshot identity');
 await assertEffectivePermission(ctx,'read:reports');
 const rows=await ctx.sql`SELECT s.protected_snapshot,s.canonical_hash,i.kind,i.id,i.company_id,i.requester_person_id,i.request_hash,i.protected_request
  FROM control_audit_snapshots s JOIN control_audit_job_intents i ON i.company_id=s.company_id AND i.id=s.job_id
  JOIN control_audit_jobs j ON j.company_id=s.company_id AND j.job_id=s.job_id AND j.state='succeeded' AND j.result_snapshot_id=s.id
  WHERE s.company_id=${ctx.principal.companyId}::uuid AND s.id=${id}::uuid` as {
   protected_snapshot:ProtectedChange;canonical_hash:string;kind:string;id:string;company_id:string;requester_person_id:string;request_hash:string;protected_request:ProtectedChange}[];
 const row=rows[0];if(rows.length!==1||!row)throw new Error('Retained snapshot unavailable');
 const saved=openAuditJobRequest(row);
 if(saved.kind!=='audit_snapshot')throw new Error('Retained snapshot job kind required');
 for(const permission of auditSnapshotPermissions(saved.request))await assertEffectivePermission(ctx,permission);
 const retained=openProtectedChange(row.protected_snapshot).after;
 if(!retained||retained.companyId!==ctx.principal.companyId||retained.snapshotId!==id||retained.jobId!==row.id)throw new Error('Retained snapshot identity changed');
 const snapshot=verifyAuditSnapshot(retained.sealed as SealedAuditSnapshot,{companyId:ctx.principal.companyId,snapshotId:id});
 const sealed=sealAuditSnapshot(snapshot);
 if(sealed.canonicalHash!==row.canonical_hash)throw new Error('Retained snapshot hash changed');
 assertSnapshotRequest(snapshot,saved.request,'retained');
 return{snapshot,sealed};
}
