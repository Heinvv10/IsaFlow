import {readComparisonIntentInputs} from './auditComparisonIntentInputs';
import {readAuditComparisonInputs} from './auditComparisonInputs';
import {randomUUID} from 'node:crypto';
import {withSavepoint} from '@/lib/neon';
import {UUID_RE} from '@/lib/validation';
import {assertEffectivePermission} from '@/lib/auth/effectivePermissions';
import {assertControlTx} from './context';
import type {ControlTx} from './contracts';
import {protectChangeValues,type ProtectedChange} from './changeProtection';
import {parseAuditSnapshotRequest,auditSnapshotPermissions,type AuditSnapshotRequest} from './auditJobContract';
import {auditRequestHash,openAuditJobRequest} from './auditJobProtection';
import {auditJobRequestPermissions} from './auditJobDelegation';
import {assertAuditEnqueueQuota} from './auditEnqueueQuota';
interface JobRow {
 kind:string;id:string;company_id:string;requester_person_id:string;request_hash:string;protected_request:ProtectedChange;
 state:'queued'|'running'|'succeeded'|'failed';attempts:number;created_at:Date|string;completed_at:Date|string|null;
 result_snapshot_id:string|null;result_export_id:string|null;result_comparison_id:string|null;result_check_run_id:string|null;last_error_code:string|null;
}
interface AuditJobStatusBase {id:string;state:JobRow['state'];attempts:number;createdAt:string;completedAt:string|null;resultSnapshotId:string|null;errorCode:string|null}
export type AuditJobStatus=AuditJobStatusBase&({kind:'audit_snapshot'}|{kind:'audit_export';resultExportId:string|null}|{kind:'audit_compare';resultComparisonId:string|null}
 |{kind:'audit_check_run';checkId:string;runGroupId:string;resultCheckRunId:string|null});
const timestamp=(value:Date|string)=>new Date(value).toISOString();
async function authorize(ctx:ControlTx,request:AuditSnapshotRequest){
 for(const permission of auditSnapshotPermissions(request))await assertEffectivePermission(ctx,permission);
}
/** Read/status never scans sources, claims leases or starts a background task. */
export async function getAuditJob(ctx:ControlTx,id:string):Promise<AuditJobStatus>{
 assertControlTx(ctx);if(!UUID_RE.test(id))throw new Error('Invalid audit job identity');
 await assertEffectivePermission(ctx,'read:reports');
 const rows=await ctx.sql`SELECT i.kind,i.id,i.company_id,i.requester_person_id,i.request_hash,i.protected_request,
  j.state,j.attempts,j.created_at,j.completed_at,j.result_snapshot_id,j.result_export_id,j.result_comparison_id,j.result_check_run_id,j.last_error_code
  FROM control_audit_job_intents i JOIN control_audit_jobs j ON j.company_id=i.company_id AND j.job_id=i.id
  WHERE i.company_id=${ctx.principal.companyId}::uuid AND i.id=${id}::uuid AND i.requester_person_id=${ctx.principal.personId}` as JobRow[];
 const row=rows[0];if(rows.length!==1||!row)throw new Error('Audit job not found');
 const evidence=openAuditJobRequest(row);
 for(const permission of auditJobRequestPermissions(evidence))await assertEffectivePermission(ctx,permission);
 if(evidence.kind==='audit_compare'){
  if('requestVersion'in evidence.request&&row.state!=='succeeded')await readComparisonIntentInputs(ctx,evidence.request);
  else await readAuditComparisonInputs(ctx,evidence.request);
 }
 if((evidence.kind!=='audit_snapshot'&&row.result_snapshot_id!==null)||(evidence.kind!=='audit_export'&&row.result_export_id!==null)
  ||(evidence.kind!=='audit_compare'&&row.result_comparison_id!==null)||(evidence.kind!=='audit_check_run'&&row.result_check_run_id!==null))throw new Error('Audit job result kind changed');
 const status={id:row.id,state:row.state,attempts:row.attempts,createdAt:timestamp(row.created_at),
  completedAt:row.completed_at===null?null:timestamp(row.completed_at),resultSnapshotId:row.result_snapshot_id,errorCode:row.last_error_code};
 return evidence.kind==='audit_snapshot'?{...status,kind:'audit_snapshot'}:evidence.kind==='audit_export'?{...status,kind:'audit_export',resultExportId:row.result_export_id}
  :evidence.kind==='audit_compare'?{...status,kind:'audit_compare',resultComparisonId:row.result_comparison_id}
  :{...status,kind:'audit_check_run',checkId:evidence.request.checkId,runGroupId:evidence.request.runGroupId,resultCheckRunId:row.result_check_run_id};
}
/**
 * One small transaction-bound enqueue. Worker authority is saved from the issued principal, never request fields.
 * Starting forensic work takes the opt-in write:audit on every transport, before any source read, and is rate-bounded.
 */
export async function enqueueAuditSnapshot(ctx:ControlTx,input:unknown):Promise<AuditJobStatus>{
 assertControlTx(ctx);const request=parseAuditSnapshotRequest(input);
 await assertEffectivePermission(ctx,'write:audit');await authorize(ctx,request);
 return withSavepoint('audit_snapshot_enqueue',async()=>{
  const principal=ctx.principal,hash=auditRequestHash(request);
  await ctx.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`audit-job:${principal.companyId}:${principal.personId}:${request.idempotencyKey}`},0))`;
  const existing=await ctx.sql`SELECT id,request_hash FROM control_audit_job_intents WHERE company_id=${principal.companyId}::uuid
   AND requester_person_id=${principal.personId} AND kind='audit_snapshot' AND idempotency_key=${request.idempotencyKey}` as {id:string;request_hash:string}[];
  if(existing.length){if(existing.length!==1||existing[0]!.request_hash!==hash)throw new Error('Idempotency key already binds a different audit request');return getAuditJob(ctx,existing[0]!.id);}
  await assertAuditEnqueueQuota(ctx,'audit_snapshot',1);
  const id=randomUUID();
  const protectedRequest=protectChangeValues('audit_job',null,{companyId:principal.companyId,jobId:id,kind:'audit_snapshot',request,
   authority:{personId:principal.personId,authMethod:principal.authMethod,connectionId:principal.connectionId,grantId:principal.grantId,
    grantedScopes:principal.grantedScopes,actingFirmId:principal.actingFirmId},delegationExpiresAt:new Date(Date.now()+86400000).toISOString()}).protectedPayload;
  await ctx.sql`INSERT INTO control_audit_job_intents(company_id,id,requester_person_id,kind,idempotency_key,request_hash,protected_request)
   VALUES(${principal.companyId}::uuid,${id}::uuid,${principal.personId},'audit_snapshot',${request.idempotencyKey},${hash},${JSON.stringify(protectedRequest)}::jsonb)`;
  await ctx.sql`INSERT INTO control_audit_jobs(company_id,job_id) VALUES(${principal.companyId}::uuid,${id}::uuid)`;
  return getAuditJob(ctx,id);
 });
}
