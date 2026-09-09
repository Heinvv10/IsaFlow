import type {PostingActorOpts} from '../gl/journalEntryMeta';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {isRealCalendarDate} from '@/lib/validation';
import {withSavepoint} from '@/lib/neon';
import {assertEffectivePermission} from '@/lib/auth/effectivePermissions';
import {assertControlTx} from '../controls/context';
import {recordCommittedChange} from '../controls/changeEventService';
import {executeControlledOperation} from '../controls/approvalExecutionService';
import {replayKnownOperationEffect} from '../controls/operationReceiptReplay';
import type {ControlTx} from '../controls/contracts';
import {assertOriginalAllocationReversible} from './bankAllocationReversalSources';
import {loadBankAllocationReversal} from './bankAllocationReversalMaterial';
import {executeBankAllocationReversalEffect} from './bankAllocationReversalEffect';
const schema=z.object({originalIntentId:z.string().uuid(),reversalDate:z.string().refine(isRealCalendarDate),reason:z.string().trim().min(1).max(1000)}).strict();
async function authority(ctx:ControlTx){assertControlTx(ctx);await assertEffectivePermission(ctx,'write:bank-tx');await assertEffectivePermission(ctx,'write:post');
 await ctx.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`control-policy:${ctx.principal.companyId}`},0))`;}
export async function prepareBankAllocationReversal(ctx:ControlTx,input:unknown){
 assertControlTx(ctx);const plan=schema.parse(input);
 return withSavepoint('bank_reversal_prepare',async()=>{
  await authority(ctx);const original=await assertOriginalAllocationReversible(ctx,plan.originalIntentId),id=randomUUID();
  await ctx.sql`INSERT INTO control_bank_allocation_reversal_intents(company_id,id,requester_person_id,original_intent_id,bank_transaction_id,reversal_date,reason)
   VALUES(${ctx.principal.companyId}::uuid,${id}::uuid,${ctx.principal.personId},${plan.originalIntentId}::uuid,${original.plan.bankTransactionId}::uuid,${plan.reversalDate}::date,${plan.reason})`;
  const state=await loadBankAllocationReversal(ctx,id);
  if(state.periods.length!==1||state.periods[0]!.status!=='open')throw new Error('Open reversal period required');
  await recordCommittedChange(ctx,{entityType:'bank_allocation_reversal_intent',entityId:id,previousVersion:null,newVersion:1,action:'bank_allocation.reversal_prepared',accountingDate:plan.reversalDate,
   before:null,after:{originalIntentId:plan.originalIntentId,bankTransactionId:original.plan.bankTransactionId,reversalDate:plan.reversalDate,reason:plan.reason},bindingHash:null,protectedEvidenceRef:null});
  return{intentId:id,operation:{entityType:'bank_allocation_reversal_intent',entityId:id,operation:'bank_allocation.reverse' as const}};
 });
}
export async function executeBankAllocationReversal(ctx:ControlTx,intentId:string,options?:PostingActorOpts&{approvalId?:string}){
 return withSavepoint('bank_reversal_execute',async()=>{
  await authority(ctx);const state=await loadBankAllocationReversal(ctx,intentId);
  if(state.intent.requester_person_id!==ctx.principal.personId)throw new Error('Bank reversal requester required');
  const ref={entityType:'bank_allocation_reversal_intent',entityId:intentId,operation:'bank_allocation.reverse' as const};
  if(state.effect)return replayKnownOperationEffect<Awaited<ReturnType<typeof executeBankAllocationReversalEffect>>>(ctx,ref,state.effect.id);
  return executeControlledOperation(ctx,ref,options?.approvalId??null,permit=>executeBankAllocationReversalEffect(ctx,intentId,permit,options));
 });
}
