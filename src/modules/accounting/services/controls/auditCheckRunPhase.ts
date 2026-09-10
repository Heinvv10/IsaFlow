import {createHash} from 'node:crypto';
import Decimal from 'decimal.js';
import {withSavepoint} from '@/lib/neon';
import {assertEffectivePermission} from '@/lib/auth/effectivePermissions';
import type {ControlTx} from './contracts';
import {canonicalJson} from './canonical';
import {assertAuditJobLease,type AuditJobLease} from './auditJobLease';
import {loadStoredAuditJobDelegation} from './auditJobDelegation';
import {AUDIT_CHECK_RUN_LIMITS} from './auditCheckRunContract';
import {auditCheckRunBudget,CheckRunPublicationFenceError,CheckRunResourceLimitError} from './auditCheckRunBudget';
import {analyseJournalRisks,journalRiskThresholdGroup} from './journalRiskAnalysis';
import {buildJournalRiskFinding,JOURNAL_RISK_COVERAGE} from './journalRiskShared';
import {journalRiskPolicySql,journalRiskThresholds,type JournalRiskPolicyRow} from './journalRiskPopulationSql';
import {checkStatus,riskAmountTotals} from './invoiceRiskQueriesResult';
import {openRetainedAuditCheckRunItem,sealAuditCheckRunHeader,sealAuditCheckRunItem,type CheckRunHeader,type CheckRunIdentity} from './auditCheckRunProtection';
import {streamJournalRiskSlabs,type CheckRunLimits} from './auditCheckRunStream';
import {writeAuditCheckRunFindings,type StagedCheckRunFinding} from './auditCheckRunWriter';
export interface CheckRunPhaseOptions {signal?:AbortSignal;deadlineAt:number}
/**
 * What the run keeps per finding while it streams: enough to verify the re-read and to total the money, never the
 * finding itself. A message can be 8 663 characters; holding 100 000 full findings (and a second decrypted copy during
 * the re-read) exhausted the worker heap before any bound refused, so the run aborted instead of publishing.
 */
interface StagedFinding {key:string;itemHash:string;amount:string;currency:string}
const itemHash=(value:unknown)=>createHash('sha256').update(canonicalJson(value)).digest('hex');
/**
 * Limits a caller may pass only to TIGHTEN the production bounds, so each bound's exact edge can be exercised with a
 * population of ten rows rather than a hundred thousand. The runner never passes any; nothing may widen one.
 */
function tightenedLimits(production:CheckRunLimits,requested:CheckRunLimits|undefined):CheckRunLimits{
 if(requested===undefined)return production;
 for(const key of Object.keys(production) as (keyof CheckRunLimits)[]){
  const base=production[key],value=requested[key];
  if(typeof base==='number'?!(Number.isSafeInteger(value)&&(value as number)>0&&(value as number)<=base):value!==base)
   throw new Error(`Check-run limits may only tighten the production bounds (${key})`);
 }
 return Object.freeze({...requested});
}
/** The job row as the publisher sees it now: its lease still live, expired, or taken by another generation. */
async function publicationLease(ctx:ControlTx,lease:AuditJobLease):Promise<'live'|'expired'|'replaced'>{
 const rows=await ctx.sql`SELECT lease_expires_at>clock_timestamp() AS live FROM control_audit_jobs
  WHERE company_id=${lease.companyId}::uuid AND job_id=${lease.jobId}::uuid AND state='running'
   AND lease_id=${lease.leaseId}::uuid AND generation=${lease.generation}` as {live:boolean}[];
 return rows.length!==1?'replaced':rows[0]!.live?'live':'expired';
}
/** The publishing worker must still hold the delegation this job was enqueued under, at this generation and lease. */
function assertWorkerAuthority(ctx:ControlTx,lease:AuditJobLease):void{
 assertAuditJobLease(ctx,lease);
 if(ctx.principal.authMethod!=='job'||ctx.principal.jobId!==lease.jobId||ctx.principal.jobLeaseId!==lease.leaseId
  ||ctx.principal.jobGeneration!==lease.generation)throw new Error('Check run publication requires original delegated worker authority');
}
/**
 * Phase A: one repeatable-read transaction records the snapshot, streams the complete journal population through the
 * shared detector functions, writes every sealed finding, re-reads them, seals the header and takes the lease-fenced
 * success pointer — all in the caller's single COMMIT. A resource limit leaves nothing behind for the unknown path.
 */
export async function runAuditCheckRunPhase(ctx:ControlTx,lease:AuditJobLease,options:CheckRunPhaseOptions,requestedLimits?:CheckRunLimits):Promise<{checkRunId:string;canonicalHash:string}>{
 assertWorkerAuthority(ctx,lease);
 const check=auditCheckRunBudget(options);check();
 return withSavepoint('audit_check_run_phase',async()=>{
  const saved=await loadStoredAuditJobDelegation(ctx.sql,lease.companyId,lease.personId,lease);
  if(saved.kind!=='audit_check_run')throw new Error('Check run publication requires check-run job kind');
  const checkId=saved.request.checkId,limits=tightenedLimits(AUDIT_CHECK_RUN_LIMITS[checkId],requestedLimits),cutoff=saved.request.cutoff;
  // Asserted once, before DECLARE, and accepted as such: a per-row assertion reloads and decrypts the delegation on every
  // journal (spike M5), and a re-check inside this repeatable-read snapshot could not see a revocation anyway. Readers
  // re-authorise against their own current permissions on every read.
  await assertEffectivePermission(ctx,'read:reports');check();
  const [snapshot]=await ctx.sql`SELECT pg_current_snapshot()::text AS snapshot_text,pg_current_xact_id()::text AS capture_xid,
   clock_timestamp() AS captured_at` as {snapshot_text:string;capture_xid:string;captured_at:Date}[];
  if(!snapshot)throw new Error('Check run transaction snapshot unavailable');
  const policies=await ctx.sql`${journalRiskPolicySql(ctx.principal.companyId)}` as JournalRiskPolicyRow[];
  const {thresholds,missingPolicy}=journalRiskThresholds(policies);check();
  const identity:CheckRunIdentity={companyId:lease.companyId,checkRunId:lease.jobId,generation:lease.generation,leaseId:lease.leaseId};
  const staged:StagedFinding[]=[],findingsDigest=createHash('sha256');
  const writer=writeAuditCheckRunFindings(ctx,lease,check);
  const groupable=(row:Parameters<typeof journalRiskThresholdGroup>[0])=>thresholds.some(threshold=>journalRiskThresholdGroup(row,threshold)!==null);
  const population=await streamJournalRiskSlabs(ctx,{cutoff,limits,check,groupable,onSlab:async rows=>{
   for(const result of analyseJournalRisks(rows,thresholds)){
    const built=buildJournalRiskFinding(result),ordinal=staged.length;
    if(ordinal>=limits.maxFindings)throw new CheckRunResourceLimitError('findings_exceed_limit');
    const item={amount:built.amount,currency:built.currency,finding:built.finding},hash=itemHash(built.finding);
    findingsDigest.update(`${ordinal}\n${built.finding.key}\n${hash}\n`);
    staged.push({key:built.finding.key,itemHash:hash,amount:built.amount,currency:built.currency});
    await writer.append({ordinal,key:built.finding.key,envelope:sealAuditCheckRunItem(identity,ordinal,item)} satisfies StagedCheckRunFinding);
   }
  }});
  await writer.flush();check();
  await assertPopulationTotals(ctx,cutoff,population.populationCount,population.populationTotals);check();
  const missing=[...new Set([...population.missing,...missingPolicy?['unsupported_or_bounded_current_journal_policy']:[],
   ...thresholds.length?[]:['no_supported_current_journal_threshold']])].sort();
  const amountTotals=riskAmountTotals(staged);
  await verifyRetainedFindings(ctx,lease,identity,staged,amountTotals,check);
  const header:CheckRunHeader={...identity,version:1,checkId,checkVersion:1,cutoff,status:checkStatus(staged.length,missing.length),
   populationCount:population.populationCount,excludedCount:0,findingCount:staged.length,populationCountBasis:'streamed',
   amountTotals,coverage:[...JOURNAL_RISK_COVERAGE],missingSources:missing,populationDigest:population.populationDigest,
   findingsDigest:findingsDigest.digest('hex'),sourceVersionCount:population.sourceVersionCount,
   permissions:saved.permissions as CheckRunHeader['permissions'],canonicalHash:'0'.repeat(64)};
  header.canonicalHash=itemHash(header);
  // The publication fence: success requires the current unexpired lease after the whole stream, not only before it,
  // checked here with its own error so a refusal names the fence that made it. Then the original delegation.
  const fenced=await publicationLease(ctx,lease);
  if(fenced!=='live')throw new CheckRunPublicationFenceError('recheck',fenced);
  await loadStoredAuditJobDelegation(ctx.sql,lease.companyId,lease.personId,lease);check();
  const rows=await ctx.sql`INSERT INTO control_audit_check_results(company_id,job_id,generation,lease_id,check_id,status,
   population_count,excluded_count,finding_count,snapshot_text,capture_xid,captured_at,protected_header)
   VALUES(${lease.companyId}::uuid,${lease.jobId}::uuid,${lease.generation},${lease.leaseId}::uuid,${checkId},${header.status},
    ${header.populationCount},${header.excludedCount},${header.findingCount},${snapshot.snapshot_text},${snapshot.capture_xid},
    ${snapshot.captured_at},${JSON.stringify(sealAuditCheckRunHeader(header))}::jsonb)
   RETURNING company_id,job_id` as {company_id:string;job_id:string}[];
  if(rows.length!==1||rows[0]?.company_id!==lease.companyId||rows[0].job_id!==lease.jobId)throw new Error('Check run result header retention failed');
  const updated=await ctx.sql`UPDATE control_audit_jobs SET state='succeeded',result_check_run_id=${lease.jobId}::uuid,
   lease_id=NULL,lease_expires_at=NULL,last_error_code=NULL,completed_at=clock_timestamp(),updated_at=clock_timestamp()
   WHERE company_id=${lease.companyId}::uuid AND job_id=${lease.jobId}::uuid AND state='running'
    AND lease_id=${lease.leaseId}::uuid AND generation=${lease.generation} AND lease_expires_at>clock_timestamp() RETURNING job_id`;
  if(updated.length!==1){const now=await publicationLease(ctx,lease);throw new CheckRunPublicationFenceError('success_pointer',now==='live'?'replaced':now);}
  check();return{checkRunId:lease.jobId,canonicalHash:header.canonicalHash};
 });
}
/** The streamed Decimal(80) population totals must equal an independent SQL aggregate over the same snapshot. */
async function assertPopulationTotals(ctx:ControlTx,cutoff:string,streamedCount:number,streamed:Record<string,string>):Promise<void>{
 const rows=await ctx.sql`SELECT c.default_currency AS currency,COALESCE(SUM(COALESCE(lines.amount,0)),0)::text AS total,COUNT(*)::text AS count
  FROM gl_journal_entries j JOIN companies c ON c.id=j.company_id
  LEFT JOIN LATERAL(SELECT SUM(l.debit) AS amount FROM gl_journal_lines l
   WHERE l.company_id=j.company_id AND l.journal_entry_id=j.id) lines ON true
  WHERE j.company_id=${ctx.principal.companyId}::uuid AND j.status='posted' AND (${cutoff}::date IS NULL OR j.entry_date<=${cutoff}::date)
  GROUP BY c.default_currency` as {currency:string|null;total:string;count:string}[];
 const Money=Decimal.clone({precision:80});let counted=0;
 for(const row of rows){
  counted+=Number(row.count);
  if(row.currency===null||!/^[A-Z]{3}$/.test(row.currency))continue;
  const streamedTotal=new Money(streamed[row.currency]??'0');
  if(!streamedTotal.eq(new Money(row.total)))throw new Error('Streamed check run population total disagrees with its SQL aggregate');
 }
 if(counted!==streamedCount)throw new Error('Streamed check run population count disagrees with its SQL aggregate');
 for(const currency of Object.keys(streamed))if(!rows.some(row=>row.currency===currency))throw new Error('Streamed check run population total has no SQL aggregate');
}
/**
 * Persistence check: every sealed finding is read back inside the same transaction before the header is written, one
 * page at a time. Each item must hash to what was staged at its ordinal; the money is re-totalled page by page from the
 * re-read bytes with the shared normalisation. No page, and no full finding, outlives its loop.
 */
async function verifyRetainedFindings(ctx:ControlTx,lease:AuditJobLease,identity:CheckRunIdentity,staged:readonly StagedFinding[],
 amountTotals:Record<string,string>,check:()=>void):Promise<void>{
 const Money=Decimal.clone({precision:80}),totals:Record<string,string>={};let count=0,after=-1;
 for(;;){
  check();
  const page=await ctx.sql`SELECT ordinal,finding_key,protected_item FROM control_audit_check_findings
   WHERE company_id=${lease.companyId}::uuid AND job_id=${lease.jobId}::uuid AND generation=${lease.generation}
    AND lease_id=${lease.leaseId}::uuid AND ordinal>${after} ORDER BY ordinal LIMIT 512` as {ordinal:number;finding_key:string;protected_item:never}[];
  if(!page.length)break;
  const money:Array<{amount:string;currency:string}>=[];
  for(const row of page){
   const expected=staged[row.ordinal];
   if(!expected||row.ordinal!==count||row.finding_key!==expected.key)throw new Error('Retained check run findings do not match the streamed run');
   const item=openRetainedAuditCheckRunItem(row.protected_item,identity,staged.length,row.ordinal);
   if(item.finding.key!==expected.key||itemHash(item.finding)!==expected.itemHash||item.amount!==expected.amount||item.currency!==expected.currency)
    throw new Error('Retained check run findings do not match the streamed run');
   money.push({amount:item.amount,currency:item.currency});count++;
  }
  for(const [currency,total] of Object.entries(riskAmountTotals(money)))totals[currency]=new Money(totals[currency]??'0').add(total).toFixed();
  after=page[page.length-1]!.ordinal;
 }
 if(count!==staged.length||canonicalJson(totals)!==canonicalJson(amountTotals))
  throw new Error('Retained check run findings do not match the streamed run');
}
