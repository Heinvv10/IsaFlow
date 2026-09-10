import {randomUUID} from 'node:crypto';
import {withSavepoint} from '@/lib/neon';
import {assertControlTx} from './context';
import type {ControlTx} from './contracts';
import {readAuditSnapshotIntentMetadata} from './auditSnapshotIntentMetadata';
import {readComparisonIntentInputs} from './auditComparisonIntentInputs';
import {parseDeferredAuditComparisonRequest} from './auditComparisonDeferredContract';
import {canonicalJson} from './canonical';
import type {ProtectedChange} from './changeProtection';
import {parseAuditComparisonRequest} from './auditComparisonJobContract';
import {auditRequestHash,openAuditJobRequest} from './auditJobProtection';
import {protectChangeValues} from './changeProtection';
import {getAuditJob,type AuditJobStatus} from './auditJobService';
/** Metadata-only enqueue. Authenticated original intents anchor sources; workers verify their retained contents. */
export async function enqueueAuditComparison(ctx:ControlTx,input:unknown):Promise<AuditJobStatus>{
 assertControlTx(ctx);
 if(ctx.principal.authMethod==='job')throw new Error('An authenticated request is required to delegate comparison work');
 const request=parseAuditComparisonRequest(input);
 const first=await readAuditSnapshotIntentMetadata(ctx,request.firstSnapshotId),second=await readAuditSnapshotIntentMetadata(ctx,request.secondSnapshotId);
 const anchor=({snapshotId,sourceJobId,sourceRequestHash}:typeof first)=>({snapshotId,sourceJobId,sourceRequestHash});
 const stored=parseDeferredAuditComparisonRequest({...request,requestVersion:2,sourceVerification:'worker',firstSource:anchor(first),secondSource:anchor(second),
  permissions:[...new Set([...first.permissions,...second.permissions])].sort(),comparisonRuleVersion:1});
 return withSavepoint('audit_compare_enqueue',async()=>{
  const principal=ctx.principal,hash=auditRequestHash(stored);
  await ctx.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`audit-job:${principal.companyId}:${principal.personId}:${request.idempotencyKey}`},0))`;
  const existing=await ctx.sql`SELECT id,company_id,requester_person_id,kind,request_hash,protected_request FROM control_audit_job_intents WHERE company_id=${principal.companyId}::uuid
   AND requester_person_id=${principal.personId} AND kind='audit_compare' AND idempotency_key=${request.idempotencyKey}` as {id:string;company_id:string;requester_person_id:string;kind:string;request_hash:string;protected_request:ProtectedChange}[];
  if(existing.length){
   if(existing.length!==1)throw new Error('Ambiguous comparison retry');
   const prior=openAuditJobRequest(existing[0]!);
   if(prior.kind!=='audit_compare'||prior.request.firstSnapshotId.toLowerCase()!==stored.firstSnapshotId
    ||prior.request.secondSnapshotId.toLowerCase()!==stored.secondSnapshotId||prior.request.idempotencyKey!==stored.idempotencyKey)throw new Error('Idempotency key already binds a different audit request');
   if('requestVersion'in prior.request&&canonicalJson(prior.request)!==canonicalJson(stored))throw new Error('Comparison retry source anchors changed');
   await readComparisonIntentInputs(ctx,prior.request);return getAuditJob(ctx,existing[0]!.id);
  }
  const id=randomUUID(),protectedRequest=protectChangeValues('audit_job',null,{companyId:principal.companyId,jobId:id,kind:'audit_compare',request:stored,
   authority:{personId:principal.personId,authMethod:principal.authMethod,connectionId:principal.connectionId,grantId:principal.grantId,
    grantedScopes:principal.grantedScopes,actingFirmId:principal.actingFirmId},delegationExpiresAt:new Date(Date.now()+86400000).toISOString()}).protectedPayload;
  await ctx.sql`INSERT INTO control_audit_job_intents(company_id,id,requester_person_id,kind,idempotency_key,request_hash,protected_request)
   VALUES(${principal.companyId}::uuid,${id}::uuid,${principal.personId},'audit_compare',${stored.idempotencyKey},${hash},${JSON.stringify(protectedRequest)}::jsonb)`;
  await ctx.sql`INSERT INTO control_audit_jobs(company_id,job_id) VALUES(${principal.companyId}::uuid,${id}::uuid)`;
  return getAuditJob(ctx,id);
 });
}
