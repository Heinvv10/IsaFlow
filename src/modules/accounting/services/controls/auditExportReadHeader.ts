import {z} from 'zod';
import {assertEffectivePermission} from '@/lib/auth/effectivePermissions';
import {assertControlTx} from './context';
import type {ControlTx} from './contracts';
import type {ProtectedChange} from './changeProtection';
import type {ExportDeliveryEnvelope} from './auditExportDeliveryContract';
import {openAuditJobRequest} from './auditJobProtection';
import {openExportDeliveryHeader} from './auditExportDeliveryMaterial';
import {readAuditSnapshotIndexHeader} from './auditSnapshotIndexRead';
import {canonicalJson} from './canonical';
interface Row {id:string;company_id:string;requester_person_id:string;kind:string;request_hash:string;protected_request:ProtectedChange;
 generation:number|string;lease_id:string;protected_header:ExportDeliveryEnvelope}
/** Current reader rights govern retained exports; expired original delegation does not erase retained evidence. */
export async function readAuditExportHeader(ctx:ControlTx,jobId:string){
 assertControlTx(ctx);z.string().uuid().parse(jobId);await assertEffectivePermission(ctx,'read:reports');
 const rows=await ctx.sql`SELECT i.id,i.company_id,i.requester_person_id,i.kind,i.request_hash,i.protected_request,
  j.generation,r.lease_id,r.protected_header FROM control_audit_jobs j
  JOIN control_audit_job_intents i ON i.company_id=j.company_id AND i.id=j.job_id
  JOIN control_audit_export_results r ON r.company_id=j.company_id AND r.job_id=j.job_id AND r.generation=j.generation
  WHERE j.company_id=${ctx.principal.companyId}::uuid AND j.job_id=${jobId}::uuid
   AND j.state='succeeded' AND j.result_export_id=j.job_id` as Row[];
 const row=rows[0];if(rows.length!==1||!row)throw new Error('Completed export unavailable');
 const saved=openAuditJobRequest(row);if(saved.kind!=='audit_export')throw new Error('Completed export request kind changed');
 for(const permission of saved.request.permissions)await assertEffectivePermission(ctx,permission);
 const snapshot=await readAuditSnapshotIndexHeader(ctx,saved.request.snapshotId);
 if(snapshot.canonicalHash!==saved.request.canonicalSnapshotHash||canonicalJson(snapshot.permissions)!==canonicalJson(saved.request.permissions))throw new Error('Export retained source identity changed');
 const header=openExportDeliveryHeader(row.protected_header,{companyId:ctx.principal.companyId,jobId,snapshotId:saved.request.snapshotId,
  canonicalSnapshotHash:saved.request.canonicalSnapshotHash,generation:Number(row.generation),leaseId:row.lease_id});
 if(canonicalJson(header.permissions)!==canonicalJson(saved.request.permissions))throw new Error('Export source permissions changed');
 return header;
}
