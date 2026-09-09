import {randomUUID} from 'node:crypto';
import {withSavepoint} from '@/lib/neon';
import {assertEffectivePermission} from '@/lib/auth/effectivePermissions';
import {assertControlTx} from './context';
import type {ControlTx} from './contracts';
import {parsePayrollCompensationInput} from './payrollCompensationPlan';
import {expandPayrollCompensation} from './payrollCompensationExpand';
import {loadPayrollCompensationSources,compensationFingerprint} from './payrollCompensationSource';
import {recordCommittedChange} from './changeEventService';
export async function preparePayrollCompensation(ctx:ControlTx,input:unknown){
 assertControlTx(ctx);const plan=parsePayrollCompensationInput(input);
 await assertEffectivePermission(ctx,'write:payroll');
 return withSavepoint('payroll_compensation_prepare',async()=>{
  await ctx.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`control-policy:${ctx.principal.companyId}`},0))`;
  const sources=await loadPayrollCompensationSources(ctx,plan.source),expanded=expandPayrollCompensation(plan,sources),id=randomUUID();
  await ctx.sql`INSERT INTO control_payroll_compensation_intents(company_id,id,requester_person_id,effective_date,amount,currency,payload,source_fingerprint)
   VALUES(${ctx.principal.companyId}::uuid,${id}::uuid,${ctx.principal.personId},${expanded.effectiveDate}::date,${expanded.amount}::numeric,'ZAR',${JSON.stringify(expanded.payload)}::jsonb,${compensationFingerprint(sources)})`;
  await recordCommittedChange(ctx,{entityType:'payroll_compensation_intent',entityId:id,previousVersion:null,newVersion:1,action:'payroll_compensation.prepared',accountingDate:expanded.effectiveDate,
   before:null,after:{sourceKind:plan.source.kind,actionCount:expanded.payload.actions.length},bindingHash:null,protectedEvidenceRef:null});
  return{intentId:id,operation:{entityType:'payroll_compensation_intent',entityId:id,operation:'payroll_compensation.change' as const}};
 });
}
