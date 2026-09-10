import {createHash} from 'node:crypto';
import {withSavepoint} from '@/lib/neon';
import {assertEffectivePermission} from '@/lib/auth/effectivePermissions';
import type {ControlTx} from './contracts';
import {canonicalJson} from './canonical';
import {assertAuditJobLease,type AuditJobLease} from './auditJobLease';
import {loadStoredAuditJobDelegation} from './auditJobDelegation';
import {JOURNAL_RISK_COVERAGE} from './journalRiskShared';
import {sealAuditCheckRunHeader,type CheckRunHeader} from './auditCheckRunProtection';
/**
 * A21: a run that hit a resource limit publishes `unknown` in a FRESH read-committed transaction under the same lease,
 * after phase A rolled back. It carries no findings and no monetary totals; its population count is a recount over the
 * same predicate in THIS transaction, which is a different snapshot from the abandoned run and is labelled as such.
 */
export async function publishAuditCheckRunUnknown(ctx:ControlTx,lease:AuditJobLease,reason:string):Promise<{checkRunId:string;canonicalHash:string}>{
 assertAuditJobLease(ctx,lease);
 if(ctx.principal.authMethod!=='job'||ctx.principal.jobId!==lease.jobId||ctx.principal.jobLeaseId!==lease.leaseId
  ||ctx.principal.jobGeneration!==lease.generation)throw new Error('Check run publication requires original delegated worker authority');
 if(!/^[a-z0-9_]{1,64}$/.test(reason))throw new Error('Invalid check run resource limit reason');
 return withSavepoint('audit_check_run_unknown',async()=>{
  const saved=await loadStoredAuditJobDelegation(ctx.sql,lease.companyId,lease.personId,lease);
  if(saved.kind!=='audit_check_run')throw new Error('Check run publication requires check-run job kind');
  await assertEffectivePermission(ctx,'read:reports');
  const cutoff=saved.request.cutoff;
  const [snapshot]=await ctx.sql`SELECT pg_current_snapshot()::text AS snapshot_text,pg_current_xact_id()::text AS capture_xid,
   clock_timestamp() AS captured_at` as {snapshot_text:string;capture_xid:string;captured_at:Date}[];
  const [counted]=await ctx.sql`SELECT COUNT(*)::text AS count FROM gl_journal_entries j
   WHERE j.company_id=${ctx.principal.companyId}::uuid AND j.status='posted'
    AND (${cutoff}::date IS NULL OR j.entry_date<=${cutoff}::date)` as {count:string}[];
  const populationCount=Number(counted?.count??NaN);
  if(!snapshot||!Number.isSafeInteger(populationCount))throw new Error('Check run population recount unavailable');
  const header:CheckRunHeader={companyId:lease.companyId,checkRunId:lease.jobId,generation:lease.generation,leaseId:lease.leaseId,
   version:1,checkId:saved.request.checkId,checkVersion:1,cutoff,status:'unknown',populationCount,excludedCount:0,findingCount:0,
   populationCountBasis:'recount_after_limit',amountTotals:{},coverage:[...JOURNAL_RISK_COVERAGE],missingSources:[`resource_limit:${reason}`],
   populationDigest:'0'.repeat(64),findingsDigest:'0'.repeat(64),sourceVersionCount:0,
   permissions:saved.permissions as CheckRunHeader['permissions'],canonicalHash:'0'.repeat(64)};
  header.canonicalHash=createHash('sha256').update(canonicalJson(header)).digest('hex');
  const rows=await ctx.sql`INSERT INTO control_audit_check_results(company_id,job_id,generation,lease_id,check_id,status,
   population_count,excluded_count,finding_count,snapshot_text,capture_xid,captured_at,protected_header)
   VALUES(${lease.companyId}::uuid,${lease.jobId}::uuid,${lease.generation},${lease.leaseId}::uuid,${header.checkId},'unknown',
    ${populationCount},0,0,${snapshot.snapshot_text},${snapshot.capture_xid},${snapshot.captured_at},
    ${JSON.stringify(sealAuditCheckRunHeader(header))}::jsonb) RETURNING company_id,job_id` as {company_id:string;job_id:string}[];
  if(rows.length!==1||rows[0]?.company_id!==lease.companyId||rows[0].job_id!==lease.jobId)throw new Error('Check run result header retention failed');
  const updated=await ctx.sql`UPDATE control_audit_jobs SET state='succeeded',result_check_run_id=${lease.jobId}::uuid,
   lease_id=NULL,lease_expires_at=NULL,last_error_code=NULL,completed_at=clock_timestamp(),updated_at=clock_timestamp()
   WHERE company_id=${lease.companyId}::uuid AND job_id=${lease.jobId}::uuid AND state='running'
    AND lease_id=${lease.leaseId}::uuid AND generation=${lease.generation} AND lease_expires_at>clock_timestamp() RETURNING job_id`;
  if(updated.length!==1)throw new Error('Check run publication lease expired or was replaced');
  return{checkRunId:lease.jobId,canonicalHash:header.canonicalHash};
 });
}
