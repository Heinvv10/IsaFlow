import {randomUUID} from 'node:crypto';
import {withSavepoint} from '@/lib/neon';
import {assertControlTx} from './context';
import type {ControlTx} from './contracts';
import {readAuditSnapshotIndexHeader} from './auditSnapshotIndexRead';
import {parseAuditExportRequest,parseStoredAuditExportRequest} from './auditExportJobContract';
import {auditRequestHash} from './auditJobProtection';
import {protectChangeValues} from './changeProtection';
import {getAuditJob,type AuditJobStatus} from './auditJobService';
/** Metadata-only enqueue. The authenticated retained index supplies source identity and permissions. */
export async function enqueueAuditExport(ctx:ControlTx,input:unknown):Promise<AuditJobStatus>{
 assertControlTx(ctx);
 if(ctx.principal.authMethod==='job')throw new Error('An authenticated request is required to delegate export work');
 const request=parseAuditExportRequest(input);
 const header=await readAuditSnapshotIndexHeader(ctx,request.snapshotId);
 const stored=parseStoredAuditExportRequest({...request,canonicalSnapshotHash:header.canonicalHash,permissions:[...header.permissions]});
 return withSavepoint('audit_export_enqueue',async()=>{
  const principal=ctx.principal,hash=auditRequestHash(stored);
  await ctx.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`audit-job:${principal.companyId}:${principal.personId}:${request.idempotencyKey}`},0))`;
  const existing=await ctx.sql`SELECT id,request_hash FROM control_audit_job_intents WHERE company_id=${principal.companyId}::uuid
   AND requester_person_id=${principal.personId} AND kind='audit_export' AND idempotency_key=${request.idempotencyKey}` as {id:string;request_hash:string}[];
  if(existing.length){if(existing.length!==1||existing[0]!.request_hash!==hash)throw new Error('Idempotency key already binds a different audit request');return getAuditJob(ctx,existing[0]!.id);}
  const id=randomUUID(),protectedRequest=protectChangeValues('audit_job',null,{companyId:principal.companyId,jobId:id,kind:'audit_export',request:stored,
   authority:{personId:principal.personId,authMethod:principal.authMethod,connectionId:principal.connectionId,grantId:principal.grantId,
    grantedScopes:principal.grantedScopes,actingFirmId:principal.actingFirmId},delegationExpiresAt:new Date(Date.now()+86400000).toISOString()}).protectedPayload;
  await ctx.sql`INSERT INTO control_audit_job_intents(company_id,id,requester_person_id,kind,idempotency_key,request_hash,protected_request)
   VALUES(${principal.companyId}::uuid,${id}::uuid,${principal.personId},'audit_export',${stored.idempotencyKey},${hash},${JSON.stringify(protectedRequest)}::jsonb)`;
  await ctx.sql`INSERT INTO control_audit_jobs(company_id,job_id) VALUES(${principal.companyId}::uuid,${id}::uuid)`;
  return getAuditJob(ctx,id);
 });
}
