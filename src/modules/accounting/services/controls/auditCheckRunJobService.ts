import {randomUUID} from 'node:crypto';
import {withSavepoint} from '@/lib/neon';
import {assertEffectivePermission} from '@/lib/auth/effectivePermissions';
import {assertControlTx} from './context';
import type {ControlTx} from './contracts';
import {protectChangeValues,type ProtectedChange} from './changeProtection';
import {auditRequestHash,openAuditJobRequest} from './auditJobProtection';
import {getAuditJob,type AuditJobStatus} from './auditJobService';
import {assertAuditEnqueueQuota} from './auditEnqueueQuota';
import {AUDIT_CHECK_RUN_IDS,AUDIT_CHECK_RUN_QUOTA,auditCheckRunIdempotencyKey,auditCheckRunIntents,parseAuditCheckRunRequest,
 type StoredAuditCheckRunRequest} from './auditCheckRunContract';
export interface AuditCheckRunEnqueueResult {runGroupId:string;jobs:AuditJobStatus[]}
interface IntentRow {id:string;company_id:string;requester_person_id:string;kind:string;request_hash:string;protected_request:ProtectedChange}
const DIFFERENT='Idempotency key already binds a different audit request';
/** A repeat must name exactly the same fan-out: every check and every derived request, byte for byte. */
function sameFanOut(existing:IntentRow[],intents:StoredAuditCheckRunRequest[]):string[]{
 if(existing.length!==intents.length)throw new Error(DIFFERENT);
 const byKey=new Map(existing.map(row=>{const opened=openAuditJobRequest(row);
  if(opened.kind!=='audit_check_run')throw new Error(DIFFERENT);return[opened.request.idempotencyKey,row] as const;}));
 return intents.map(intent=>{const row=byKey.get(intent.idempotencyKey);
  if(!row||row.request_hash!==auditRequestHash(intent))throw new Error(DIFFERENT);return row.id;});
}
/**
 * Metadata-only enqueue of one job per check; workers alone scan sources. Authority is the issued principal.
 * Enqueueing is a write: it takes the opt-in `write:audit` on every transport, on top of each check's own read
 * permission, and both are decided before the quota is consulted.
 */
export async function enqueueAuditCheckRuns(ctx:ControlTx,input:unknown):Promise<AuditCheckRunEnqueueResult>{
 assertControlTx(ctx);
 if(ctx.principal.authMethod==='job')throw new Error('An authenticated request is required to delegate check-run work');
 const request=parseAuditCheckRunRequest(input),principal=ctx.principal;
 const intents=auditCheckRunIntents(principal.companyId,principal.personId,request);
 await assertEffectivePermission(ctx,'write:audit');
 for(const permission of new Set(intents.flatMap(intent=>intent.permissions)))await assertEffectivePermission(ctx,permission);
 const runGroupId=intents[0]!.runGroupId;
 return withSavepoint('audit_check_run_enqueue',async()=>{
  // One company-wide lock serialises both the idempotency lookup and the quota count it guards.
  await ctx.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`audit-check-run:${principal.companyId}`},0))`;
  const everyKey=AUDIT_CHECK_RUN_IDS.map(check=>auditCheckRunIdempotencyKey(request.idempotencyKey,check));
  const existing=await ctx.sql`SELECT id,company_id,requester_person_id,kind,request_hash,protected_request FROM control_audit_job_intents
   WHERE company_id=${principal.companyId}::uuid AND requester_person_id=${principal.personId} AND kind='audit_check_run'
    AND idempotency_key=ANY(${everyKey}::text[])` as IntentRow[];
  if(existing.length){
   const ids=sameFanOut(existing,intents),jobs:AuditJobStatus[]=[];
   for(const id of ids)jobs.push(await getAuditJob(ctx,id));
   return{runGroupId,jobs};
  }
  await assertAuditEnqueueQuota(ctx,'audit_check_run',intents.length,AUDIT_CHECK_RUN_QUOTA.maxActiveJobs);
  const jobs:AuditJobStatus[]=[];
  for(const stored of intents){
   const id=randomUUID(),protectedRequest=protectChangeValues('audit_job',null,{companyId:principal.companyId,jobId:id,kind:'audit_check_run',request:stored,
    authority:{personId:principal.personId,authMethod:principal.authMethod,connectionId:principal.connectionId,grantId:principal.grantId,
     grantedScopes:principal.grantedScopes,actingFirmId:principal.actingFirmId},delegationExpiresAt:new Date(Date.now()+86400000).toISOString()}).protectedPayload;
   await ctx.sql`INSERT INTO control_audit_job_intents(company_id,id,requester_person_id,kind,idempotency_key,request_hash,protected_request)
    VALUES(${principal.companyId}::uuid,${id}::uuid,${principal.personId},'audit_check_run',${stored.idempotencyKey},${auditRequestHash(stored)},${JSON.stringify(protectedRequest)}::jsonb)`;
   await ctx.sql`INSERT INTO control_audit_jobs(company_id,job_id) VALUES(${principal.companyId}::uuid,${id}::uuid)`;
   jobs.push(await getAuditJob(ctx,id));
  }
  return{runGroupId,jobs};
 });
}
