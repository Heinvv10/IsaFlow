import {UUID_RE} from '@/lib/validation';
import {randomUUID} from 'node:crypto';
import {withSavepoint} from '@/lib/neon';
import {assertEffectivePermission} from '@/lib/auth/effectivePermissions';
import type {ControlTx} from '../controls/contracts';
import {assertControlTx} from '../controls/context';
import {recordCommittedChange} from '../controls/changeEventService';
import {parseCashApplicationReversalPlan} from './cashApplicationPlan';
import {assertCashApplicationReversible} from './cashApplicationReversalSources';
import {loadCashApplicationReversal} from './cashApplicationReversalMaterial';
export async function prepareCashApplicationReversal(ctx:ControlTx,input:unknown){
 assertControlTx(ctx);await assertEffectivePermission(ctx,'write:bank-tx');await assertEffectivePermission(ctx,'write:post');
 const plan=parseCashApplicationReversalPlan(input);
 return withSavepoint('cash_reversal_prepare',async()=>{
  await ctx.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`control-policy:${ctx.principal.companyId}`},0))`;
  const original=await assertCashApplicationReversible(ctx,plan.originalIntentId),id=randomUUID();
  if(plan.reversalDate<original.plan.accountingDate)throw new Error('Cash reversal cannot predate application');
  await ctx.sql`INSERT INTO control_cash_application_reversal_intents(company_id,id,requester_person_id,original_intent_id,reversal_date,reason)
   VALUES(${ctx.principal.companyId}::uuid,${id}::uuid,${ctx.principal.personId},${plan.originalIntentId}::uuid,${plan.reversalDate}::date,${plan.reason})`;
  const state=await loadCashApplicationReversal(ctx,id),ledger=original.sources.ledger;
  if(state.periods.length!==1||state.periods[0]!.status!=='open'||state.vatLocks.length)throw new Error('Open unlocked cash reversal period required');
  if(ledger.lockdown_enabled===true&&(!ledger.lockdown_date||plan.reversalDate<=String(ledger.lockdown_date)))throw new Error('Cash reversal date is locked');
  await recordCommittedChange(ctx,{entityType:'cash_application_reversal_intent',entityId:id,previousVersion:null,newVersion:1,action:'cash_application.reversal_prepared',accountingDate:plan.reversalDate,
   before:null,after:{originalIntentId:plan.originalIntentId,paymentId:original.plan.paymentId,reason:plan.reason},bindingHash:null,protectedEvidenceRef:null});
  return{intentId:id,operation:{entityType:'cash_application_reversal_intent',entityId:id,operation:'cash_application.reverse' as const}};
 });
}

export async function executeCashApplicationReversal(ctx:ControlTx,intentId:string,options?:{approvalId?:string}){
 assertControlTx(ctx);if(!UUID_RE.test(intentId))throw new Error('Invalid controlled intent UUID');intentId=intentId.toLowerCase();
 await assertEffectivePermission(ctx,'write:bank-tx');await assertEffectivePermission(ctx,'write:post');
 const {loadCashApplicationReversal}=await import('./cashApplicationReversalMaterial');
 const {executeControlledOperation}=await import('../controls/approvalExecutionService');
 const {replayKnownOperationEffect}=await import('../controls/operationReceiptReplay');
 const {executeCashApplicationReversalEffect}=await import('./cashApplicationReversalEffect');
 return withSavepoint('cash_reversal_execute',async()=>{
  await ctx.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`control-policy:${ctx.principal.companyId}`},0))`;
  const material=await loadCashApplicationReversal(ctx,intentId);
  if(material.intent.requester_person_id!==ctx.principal.personId)throw new Error('Cash application requester required');
  const ref={entityType:'cash_application_reversal_intent',entityId:intentId,operation:'cash_application.reverse' as const};
  if(material.effect)return replayKnownOperationEffect<Awaited<ReturnType<typeof executeCashApplicationReversalEffect>>>(ctx,ref,material.effect.id);
  return executeControlledOperation(ctx,ref,options?.approvalId??null,permit=>executeCashApplicationReversalEffect(ctx,ref,permit));
 });
}
