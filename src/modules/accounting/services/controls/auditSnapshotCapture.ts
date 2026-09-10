import {performance} from 'node:perf_hooks';
import {z} from 'zod';
import Decimal from 'decimal.js';
import {assertControlTx} from './context';
import type {ControlTx} from './contracts';
import {assertEffectivePermission} from '@/lib/auth/effectivePermissions';
import {canonicalJson} from './canonical';
import {AUDIT_JOB_LIMITS,auditSnapshotPermissions,parseAuditSnapshotRequest,type AuditSnapshotRequest} from './auditJobContract';
import type {AuditSnapshotData} from './auditSnapshotSeal';
import {ledgerSnapshotSources} from './auditSnapshotCaptureQueries';
import {sageInvoiceSnapshotSources} from './auditSnapshotSageInvoiceQueries';
import {invoiceSnapshotSources} from './auditSnapshotInvoiceQueries';
import {payrollSnapshotSources} from './auditSnapshotPayrollQueries';
import {captureSnapshotChecks} from './auditSnapshotCheckCapture';
const D=Decimal.clone({precision:80});
const moneyFields=new Set(['debit','credit','amount','subtotal','tax_amount','total_amount','amount_paid','amount_allocated',
 'total_gross','total_taxable','total_paye','total_uif','total_sdl','total_eti','total_net','gross_pay','taxable_income','paye','uif_employee','uif_employer','sdl','eti','net_pay']);
/** Materializes current owned accounting facts at the cutoff, in the caller's consistent database snapshot. */
export async function captureAuditSnapshot(ctx:ControlTx,input:{snapshotId:string;request:AuditSnapshotRequest}):Promise<AuditSnapshotData>{
 assertControlTx(ctx);
 const detached=z.object({snapshotId:z.string().uuid(),request:z.unknown()}).strict().parse(JSON.parse(canonicalJson(input)));
 const request=parseAuditSnapshotRequest(detached.request),started=performance.now();
 const budget=()=>{if(performance.now()-started>=AUDIT_JOB_LIMITS.maxRunSeconds*1000)throw new Error('Snapshot runtime resource limit');};
 const [state]=await ctx.sql`SELECT current_setting('transaction_isolation') AS isolation,clock_timestamp()::text AS captured_at,
  current_setting('statement_timeout') AS timeout,EXTRACT(EPOCH FROM current_setting('statement_timeout')::interval)*1000 AS timeout_ms` as Array<{isolation:string;captured_at:string;timeout:string;timeout_ms:string}>;
 if(state?.isolation!=='repeatable read')throw new Error('Snapshot capture requires REPEATABLE READ');
 const queryBudget=async()=>{
  budget();const remaining=Math.max(1,Math.floor(AUDIT_JOB_LIMITS.maxRunSeconds*1000-(performance.now()-started)));
  const timeout=Math.min(remaining,Number(state.timeout_ms)||remaining);
  await ctx.sql`SELECT set_config('statement_timeout',${`${timeout}ms`},true)`;
 };
 await queryBudget();
 for(const permission of auditSnapshotPermissions(request))await assertEffectivePermission(ctx,permission);
 const result:AuditSnapshotData={version:1,companyId:ctx.principal.companyId,snapshotId:detached.snapshotId,cutoff:request.cutoff,
  capturedAt:new Date(state.captured_at).toISOString(),records:[],populations:[],checks:[],evidence:[],
  coverage:['current_values_at_accounting_cutoff_not_historical_database_state','explicit_accounting_fields_only',
   'names_tokens_tax_identifiers_bank_details_and_freeform_text_excluded','retained_reversed_allocations_are_history_not_current_balance'],
  missingSources:['retained_evidence_not_attached']};
 const sources=[...ledgerSnapshotSources,...invoiceSnapshotSources,...sageInvoiceSnapshotSources,...payrollSnapshotSources].filter(s=>request.sources.includes(s.family));
 let retainedBytes=0;
 for(const source of sources){
  await queryBudget();const counts=await source.counts(ctx,request.cutoff);budget();
  if(!Number.isSafeInteger(counts.count)||!Number.isSafeInteger(counts.excludedCount)||counts.count<0||counts.excludedCount<0
   ||result.records.length+counts.count>AUDIT_JOB_LIMITS.maxRecords||counts.excludedCount>AUDIT_JOB_LIMITS.maxRecords)
   throw new Error('Snapshot population resource limit');
  result.populations.push({source:source.source,...counts,exclusions:counts.excludedCount?['accounting_date_after_cutoff']:[]});
  const totals:Record<string,Decimal>={};let after:string|null=null,captured=0;
  while(captured<counts.count){
   await queryBudget();const page=await source.page(ctx,request.cutoff,after);budget();
   if(!page.length||page.length>AUDIT_JOB_LIMITS.pageSize||captured+page.length>counts.count)throw new Error('Incomplete snapshot source population');
   for(const row of page){
    if(after!==null&&row.id<=after)throw new Error('Snapshot source keyset did not advance');after=row.id;
    const version=row.version===null?null:Number(row.version);
    if(version!==null&&(!Number.isSafeInteger(version)||version<1))throw new Error('Invalid snapshot source version');
    const record={source:source.source,...row,version};retainedBytes+=Buffer.byteLength(canonicalJson(record));
    if(retainedBytes>100*1024*1024)throw new Error('Snapshot byte resource limit');result.records.push(record);captured++;
    if(row.version===null)result.missingSources.push(`${source.source}:historical_entity_versions_unavailable`);
    // These are problems a reviewer must see, so they are listed with the gaps, never as coverage.
    // A forked record reports its most advanced lineage; the sibling lineage exists and the snapshot says so.
    if(row.data.control_lineage_forked===true)result.missingSources.push(`forked_lineage:${source.source}`);
    // A top-version tie with no canonical spelling: writers refuse the entity until someone adjudicates it.
    if(row.data.control_lineage_tie_unresolvable===true)result.missingSources.push(`unresolvable_lineage_tie:${source.source}`);
    // A twin receipt is evidence of a second execution of one intent.
    if(row.data.control_receipt_twinned===true)result.missingSources.push(`twinned_receipt:${source.source}`);
    for(const [key,value] of Object.entries(row.data)){
     if(key.endsWith('_unavailable')&&value===true)result.missingSources.push(`${source.source}:${key}`);
     if(moneyFields.has(key)&&typeof value==='string'){
      const currency=typeof row.data.currency==='string'&&/^[A-Z]{3}$/.test(row.data.currency)?row.data.currency:'UNSPECIFIED';
      if(currency==='UNSPECIFIED')result.missingSources.push(`${source.source}:amount_currency_unavailable`);
      const totalKey=`${key}:${currency}`;totals[totalKey]=(totals[totalKey]??new D(0)).plus(value);
     }
    }
   }
  }
  for(const [field,total] of Object.entries(totals))result.coverage.push(`population_total:${source.source}:${field}:${total.toFixed()}`);
 }
 result.checks=await captureSnapshotChecks(ctx,request,queryBudget);budget();
 if(request.sources.includes('payroll'))result.coverage.push('payroll_names_tax_bank_details_and_component_payloads_excluded','payroll_component_payloads_retained_as_domain_separated_hmac_only');
 for(const check of result.checks)result.missingSources.push(...check.missingSources.map(missing=>`${check.checkId}:${missing}`));
 result.coverage=[...new Set(result.coverage)].sort();result.missingSources=[...new Set(result.missingSources)].sort();
 if(Buffer.byteLength(canonicalJson(result))>100*1024*1024)throw new Error('Snapshot byte resource limit');
 await ctx.sql`SELECT set_config('statement_timeout',${state.timeout},true)`;
 return result;
}
