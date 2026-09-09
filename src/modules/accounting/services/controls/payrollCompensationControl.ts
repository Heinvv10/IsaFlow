import {z} from 'zod';
import {canonicalJson} from './canonical';
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

export async function executePayrollCompensation(ctx:ControlTx,intentId:string,options:{approvalId?:string}={}){
 assertControlTx(ctx);
 const id=z.string().uuid().parse(intentId),saved=z.object({approvalId:z.string().uuid().optional()}).strict().parse(JSON.parse(canonicalJson(options)));
 await assertEffectivePermission(ctx,'write:payroll');
 const {loadPayrollCompensationIntent}=await import('./payrollCompensationMaterial');
 const {executeControlledOperation}=await import('./approvalExecutionService');
 const {replayKnownOperationEffect}=await import('./operationReceiptReplay');
 const {executePayrollCompensationEffect}=await import('./payrollCompensationEffect');
 return withSavepoint('payroll_compensation_execute',async()=>{
  await ctx.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`control-policy:${ctx.principal.companyId}`},0))`;
  const material=await loadPayrollCompensationIntent(ctx,id);
  if(material.intent.requester_person_id!==ctx.principal.personId)throw new Error('Original compensation requester required');
  const ref={entityType:'payroll_compensation_intent',entityId:id,operation:'payroll_compensation.change' as const};
  if(material.effect)return replayKnownOperationEffect<Awaited<ReturnType<typeof executePayrollCompensationEffect>>>(ctx,ref,material.effect.id);
  return executeControlledOperation(ctx,ref,saved.approvalId??null,permit=>executePayrollCompensationEffect(ctx,id,permit));
 });
}
