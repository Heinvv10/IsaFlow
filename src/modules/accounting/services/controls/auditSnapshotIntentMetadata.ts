import {z} from 'zod';
import {assertEffectivePermission} from '@/lib/auth/effectivePermissions';
import {assertControlTx} from './context';
import type {ControlTx} from './contracts';
import type {ProtectedChange} from './changeProtection';
import {openAuditJobRequest} from './auditJobProtection';
import {auditSnapshotPermissions} from './auditJobContract';
interface Row {snapshot_id:string;id:string;company_id:string;requester_person_id:string;kind:string;request_hash:string;protected_request:ProtectedChange|null}
/** Original authenticated request anchor only, not verification of retained snapshot contents. Never starts conversion. */
export async function readAuditSnapshotIntentMetadata(ctx:ControlTx,snapshotId:string){
 assertControlTx(ctx);snapshotId=z.string().uuid().parse(snapshotId).toLowerCase();
 await assertEffectivePermission(ctx,'read:reports');
 const rows=await ctx.sql`SELECT s.id AS snapshot_id,i.id,i.company_id,i.requester_person_id,i.kind,i.request_hash,
  CASE WHEN octet_length(i.protected_request::text)<=65536 THEN i.protected_request ELSE NULL END AS protected_request
  FROM control_audit_snapshots s
  JOIN control_audit_job_intents i ON i.company_id=s.company_id AND i.id=s.job_id
  JOIN control_audit_jobs j ON j.company_id=s.company_id AND j.job_id=s.job_id
  WHERE s.company_id=${ctx.principal.companyId}::uuid AND s.id=${snapshotId}::uuid
   AND j.state='succeeded' AND j.result_snapshot_id=s.id` as Row[];
 const row=rows[0];
 if(rows.length!==1||!row||row.company_id!==ctx.principal.companyId||row.snapshot_id!==snapshotId)throw new Error('Retained snapshot intent unavailable');
 if(!row.protected_request)throw new Error('Retained snapshot intent unavailable or exceeds byte limit');
 const saved=openAuditJobRequest({...row,protected_request:row.protected_request});
 if(saved.kind!=='audit_snapshot')throw new Error('Retained snapshot intent kind changed');
 const permissions=auditSnapshotPermissions(saved.request);
 for(const permission of permissions)await assertEffectivePermission(ctx,permission);
 return Object.freeze({snapshotId,sourceJobId:row.id,sourceRequestHash:row.request_hash,permissions:Object.freeze([...permissions])});
}
