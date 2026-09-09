import type {TxSql} from '@/lib/neon';
import {UUID_RE} from '@/lib/validation';
import {openAuditJobRequest} from './auditJobProtection';
import {auditSnapshotPermissions} from './auditJobContract';
import type {ProtectedChange} from './changeProtection';
export interface AuditJobLeaseReference {jobId:string;leaseId:string;generation:number}
/** Internal bootstrap and permission recheck: authority comes from protected storage plus the live lease. */
export async function loadStoredAuditJobDelegation(sql:TxSql,companyId:string,personId:string,lease:AuditJobLeaseReference){
 if(!UUID_RE.test(companyId)||!personId||!UUID_RE.test(lease.jobId)||!UUID_RE.test(lease.leaseId)
  ||!Number.isSafeInteger(lease.generation)||lease.generation<1)throw new Error('Invalid audit job lease');
 const rows=await sql`SELECT i.kind,i.id,i.company_id,i.requester_person_id,i.request_hash,i.protected_request
  FROM control_audit_job_intents i JOIN control_audit_jobs j ON j.company_id=i.company_id AND j.job_id=i.id
  WHERE i.company_id=${companyId}::uuid AND i.id=${lease.jobId}::uuid AND i.requester_person_id=${personId}
   AND j.state='running' AND j.lease_id=${lease.leaseId}::uuid
   AND j.generation=${lease.generation} AND j.lease_expires_at>clock_timestamp()
  FOR SHARE OF j` as {kind:string;id:string;company_id:string;requester_person_id:string;request_hash:string;protected_request:ProtectedChange}[];
 if(rows.length!==1||!rows[0])throw new Error('Audit job lease expired or was replaced');
 const delegation=openAuditJobRequest(rows[0]);
 const [clock]=await sql`SELECT ${delegation.delegationExpiresAt}::timestamptz>clock_timestamp() AS valid` as {valid:boolean}[];
 if(clock?.valid!==true)throw new Error('Audit job delegation expired');
 return{...delegation,permissions:delegation.kind==='audit_snapshot'?auditSnapshotPermissions(delegation.request):delegation.request.permissions};
}
