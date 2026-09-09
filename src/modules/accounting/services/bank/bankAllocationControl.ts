import {randomUUID} from 'node:crypto';
import Decimal from 'decimal.js';
import {fmtDate} from '@/lib/fmtDate';
import {withSavepoint} from '@/lib/neon';
import {assertEffectivePermission} from '@/lib/auth/effectivePermissions';
import {assertControlTx} from '../controls/context';
import {recordCommittedChange} from '../controls/changeEventService';
import type {ControlTx} from '../controls/contracts';
import {allocationMoney,parseBankAllocationPlan} from './bankAllocationPlan';
import {loadBankAllocationSources} from './bankAllocationSources';
export async function prepareBankAllocation(ctx:ControlTx,input:unknown){
 assertControlTx(ctx);await assertEffectivePermission(ctx,'write:bank-tx');await assertEffectivePermission(ctx,'write:post');
 const plan=parseBankAllocationPlan(input);
 return withSavepoint('bank_allocation_prepare',async()=>{
  await ctx.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`control-policy:${ctx.principal.companyId}`},0))`;
  const sources=await loadBankAllocationSources(ctx,plan);
  if(sources.bank.status!=='imported')throw new Error('Imported bank transaction required');
  for(const item of sources.invoices){const invoice=item.invoice as Record<string,unknown>,allocation=item.allocation as {amount:string};
   if(new Decimal(String(invoice.amount_paid)).add(allocation.amount).gt(String(invoice.total_amount)))throw new Error('Allocation exceeds invoice outstanding');
  }
  const id=randomUUID(),date=fmtDate(sources.bank.transaction_date as string|Date),amount=allocationMoney(new Decimal(String(sources.bank.amount)).abs().toFixed());
  await ctx.sql`INSERT INTO control_bank_allocation_intents(company_id,id,requester_person_id,bank_transaction_id,accounting_date,amount,currency,payload,source_fingerprint)
   VALUES(${ctx.principal.companyId}::uuid,${id}::uuid,${ctx.principal.personId},${plan.bankTransactionId}::uuid,${date}::date,${amount}::numeric,'ZAR',${JSON.stringify(plan)}::jsonb,${sources.fingerprint})`;
  await recordCommittedChange(ctx,{entityType:'bank_allocation_intent',entityId:id,previousVersion:null,newVersion:1,action:'bank_allocation.prepared',accountingDate:date,
   before:null,after:{bankTransactionId:plan.bankTransactionId,kind:plan.kind,amount,currency:'ZAR'},bindingHash:null,protectedEvidenceRef:null});
  return{intentId:id,operation:{entityType:'bank_allocation_intent',entityId:id,operation:'bank_allocation.post' as const}};
 });
}

export async function executeBankAllocation(ctx:ControlTx,intentId:string,options?:{approvalId?:string}){
 assertControlTx(ctx);await assertEffectivePermission(ctx,'write:bank-tx');await assertEffectivePermission(ctx,'write:post');
 const {loadBankAllocationIntent}=await import('./bankAllocationMaterial');
 const {executeControlledOperation}=await import('../controls/approvalExecutionService');
 const {replayKnownOperationEffect}=await import('../controls/operationReceiptReplay');
 const {executeBankAllocationEffect}=await import('./bankAllocationEffect');
 return withSavepoint('bank_allocation_execute',async()=>{
  await ctx.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`control-policy:${ctx.principal.companyId}`},0))`;
  const material=await loadBankAllocationIntent(ctx,intentId);
  if(material.intent.requester_person_id!==ctx.principal.personId)throw new Error('Allocation requester required');
  const ref={entityType:'bank_allocation_intent',entityId:intentId,operation:'bank_allocation.post' as const};
  if(material.effect)return replayKnownOperationEffect<Awaited<ReturnType<typeof executeBankAllocationEffect>>>(ctx,ref,material.effect.id);
  return executeControlledOperation(ctx,ref,options?.approvalId??null,permit=>executeBankAllocationEffect(ctx,intentId,permit));
 });
}
