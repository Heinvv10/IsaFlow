import {randomUUID} from 'node:crypto';
import {withSavepoint} from '@/lib/neon';
import {assertControlTx} from './context';
import type {ControlTx} from './contracts';
import {AUDIT_JOB_LIMITS} from './auditJobContract';
import {getAuditJob} from './auditJobService';
export interface AuditJobLease {readonly companyId:string;readonly personId:string;readonly jobId:string;readonly leaseId:string;readonly generation:number}
const issued=new WeakSet<AuditJobLease>();
const ERROR_CODES=['SOURCE_UNAVAILABLE','AUTHORITY_REVOKED','EVIDENCE_CHANGED','RESOURCE_LIMIT','WORKER_ERROR','RETRY_EXHAUSTED'] as const;
export type AuditJobErrorCode=typeof ERROR_CODES[number];
/** A lease is an internal capability; copying its visible identifiers never creates authority. */
export function assertAuditJobLease(ctx:ControlTx,lease:AuditJobLease):void{
 assertControlTx(ctx);
 if(!issued.has(lease)||lease.companyId!==ctx.principal.companyId||lease.personId!==ctx.principal.personId)throw new Error('Invalid audit job lease authority');
}
/** Called by the worker, never a status/read path. SQL generation fencing survives worker restarts. */
export async function claimAuditJob(ctx:ControlTx,id:string):Promise<AuditJobLease|null>{
 assertControlTx(ctx);await getAuditJob(ctx,id);
 return withSavepoint('audit_job_claim',async()=>{
  const rows=await ctx.sql`SELECT attempts,generation FROM control_audit_jobs
   WHERE company_id=${ctx.principal.companyId}::uuid AND job_id=${id}::uuid
    AND (state='queued' OR (state='running' AND lease_expires_at<=clock_timestamp()))
   FOR UPDATE SKIP LOCKED` as {attempts:number;generation:string|number}[];
  const row=rows[0];if(!row)return null;
  if(row.attempts>=AUDIT_JOB_LIMITS.maxAttempts){
   await ctx.sql`UPDATE control_audit_jobs SET state='failed',lease_id=NULL,lease_expires_at=NULL,
    last_error_code='RETRY_EXHAUSTED',completed_at=clock_timestamp(),updated_at=clock_timestamp()
    WHERE company_id=${ctx.principal.companyId}::uuid AND job_id=${id}::uuid`;
   return null;
  }
  const lease=Object.freeze({companyId:ctx.principal.companyId,personId:ctx.principal.personId,jobId:id,leaseId:randomUUID(),generation:Number(row.generation)+1});
  await ctx.sql`UPDATE control_audit_jobs SET state='running',attempts=attempts+1,generation=${lease.generation},lease_id=${lease.leaseId}::uuid,
   lease_expires_at=clock_timestamp()+${AUDIT_JOB_LIMITS.leaseSeconds}*interval '1 second',started_at=COALESCE(started_at,clock_timestamp()),
   completed_at=NULL,updated_at=clock_timestamp()
   WHERE company_id=${ctx.principal.companyId}::uuid AND job_id=${id}::uuid`;
  issued.add(lease);return lease;
 });
}
/** Sanitized failure publication still needs the exact unexpired active lease; no financial/source mutation. */
export async function failAuditJob(ctx:ControlTx,lease:AuditJobLease,code:AuditJobErrorCode,retryable:boolean):Promise<void>{
 assertAuditJobLease(ctx,lease);if(!ERROR_CODES.includes(code))throw new Error('Invalid audit job error code');
 const rows=await ctx.sql`UPDATE control_audit_jobs SET
  state=CASE WHEN ${retryable} AND attempts<${AUDIT_JOB_LIMITS.maxAttempts} THEN 'queued' ELSE 'failed' END,
  completed_at=CASE WHEN ${retryable} AND attempts<${AUDIT_JOB_LIMITS.maxAttempts} THEN NULL ELSE clock_timestamp() END,
  lease_id=NULL,lease_expires_at=NULL,last_error_code=${code},updated_at=clock_timestamp()
  WHERE company_id=${ctx.principal.companyId}::uuid AND job_id=${lease.jobId}::uuid AND state='running'
   AND lease_id=${lease.leaseId}::uuid AND generation=${lease.generation} AND lease_expires_at>clock_timestamp()
  RETURNING job_id`;
 if(rows.length!==1)throw new Error('Audit job lease expired or was replaced');
}
