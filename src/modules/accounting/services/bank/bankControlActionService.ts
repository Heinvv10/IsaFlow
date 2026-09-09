import type {PostingActorOpts} from '../gl/journalEntryMeta';
import {resolveBankTransferOriginal} from '@/modules/accounting/services/bank/bankAllocationTransferOriginal';
import Decimal from 'decimal.js';
import {assertEffectivePermission} from '@/lib/auth/effectivePermissions';
import {assertControlTx} from '@/modules/accounting/services/controls/context';
import type {ControlTx} from '@/modules/accounting/services/controls/contracts';
import {preparePartyBankAllocation} from '@/modules/accounting/services/bank/bankAllocationDefaultPreparation';
import {prepareBankAllocation,executeBankAllocation} from '@/modules/accounting/services/bank/bankAllocationControl';
import {loadBankAllocationIntent} from '@/modules/accounting/services/bank/bankAllocationMaterial';
import {prepareBankAllocationReversal} from '@/modules/accounting/services/bank/bankAllocationReversal';
import {loadBankAllocationOriginal} from '@/modules/accounting/services/bank/bankAllocationReversalSources';
import {loadBankAllocationReversal} from '@/modules/accounting/services/bank/bankAllocationReversalMaterial';
import {reverseReconciledTransaction} from '@/modules/accounting/services/bank/bankAllocationService';
import {mapTxRow} from '@/modules/accounting/services/bank/bankTransactionQueryService';
import type {DbRow} from '@/lib/neon';
import {bankControlSchema} from './bankControlActionSchema';
/** Shared attended bank commands. Both transports execute the same immutable approved instruction. */
export async function dispatchBankControlAction(ctx:ControlTx,input:unknown,actor?:PostingActorOpts){
 assertControlTx(ctx);const body=bankControlSchema.parse(input),company=ctx.principal.companyId;
 await assertEffectivePermission(ctx,'write:bank-tx');await assertEffectivePermission(ctx,'write:post');
 await ctx.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`control-policy:${company}`},0))`;
 if(body.action==='prepare_allocate'){
  if(body.allocationType==='transfer'){
   if(!body.contraAccountId||body.entityId||body.vatCode!==undefined||body.vatAccountId||body.cc1Id||body.cc2Id||body.buId
    ||body.autoApply!==undefined||body.applications!==undefined)throw new Error('Transfer preparation requires only the owned counterparty bank account');
   return prepareBankAllocation(ctx,{version:1,kind:'transfer',bankTransactionId:body.bankTransactionId,counterpartyAccountId:body.contraAccountId,description:body.description});
  }
  if(body.allocationType!=='account'){
   if(!body.entityId||body.contraAccountId||body.vatAccountId||body.vatCode)throw new Error('Party preparation requires only the owned party and application instructions');
   return preparePartyBankAllocation(ctx,{kind:body.allocationType,bankTransactionId:body.bankTransactionId,partyId:body.entityId,
    description:body.description,autoApply:body.autoApply,applications:body.applications,cc1Id:body.cc1Id,cc2Id:body.cc2Id,buId:body.buId});
  }
  if(!body.contraAccountId||body.entityId||body.autoApply!==undefined||body.applications!==undefined)throw new Error('Account preparation requires only the owned contra account');
  const [bank]=await ctx.sql`SELECT amount::text FROM bank_transactions WHERE company_id=${company}::uuid AND id=${body.bankTransactionId}::uuid FOR UPDATE` as {amount:string}[];
  if(!bank)throw new Error('Owned bank transaction not found');
  return prepareBankAllocation(ctx,{version:1,kind:'account',bankTransactionId:body.bankTransactionId,description:body.description,vatAccountId:body.vatAccountId,
   lines:[{accountId:body.contraAccountId,amount:new Decimal(bank.amount).abs().toFixed(),vatCode:body.vatCode??'none',cc1Id:body.cc1Id,cc2Id:body.cc2Id,buId:body.buId}]});
 }
 if(body.action==='prepare_split_allocate')return prepareBankAllocation(ctx,{version:1,kind:'split',bankTransactionId:body.bankTransactionId,description:body.description,vatAccountId:body.vatAccountId,
  lines:body.lines.map(line=>({accountId:line.contraAccountId,amount:line.amount,description:line.description,vatCode:line.vatCode??'none',cc1Id:line.cc1Id,cc2Id:line.cc2Id,buId:line.buId}))});
 if(body.action==='prepare_reverse'){
  const originalIntentId=await resolveBankTransferOriginal(ctx,body.originalIntentId);
  const original=await loadBankAllocationOriginal(ctx,originalIntentId);
  if(original.plan.bankTransactionId!==body.bankTransactionId&&!original.transfer?.banks.some(bank=>bank.id===body.bankTransactionId))throw new Error('Prepared original bank does not match request');
  return prepareBankAllocationReversal(ctx,{originalIntentId,reversalDate:body.reversalDate,reason:body.reason});
 }
 if(body.action==='reverse'){
  const state=await loadBankAllocationReversal(ctx,body.intent_id);
  if(state.intent.bank_transaction_id!==body.bankTransactionId||(body.reversalDate!==undefined&&state.intent.reversal_date!==body.reversalDate)
   ||(body.reason!==undefined&&state.intent.reason!==body.reason))throw new Error('Prepared inverse does not match request');
  const result=await reverseReconciledTransaction(company,body.bankTransactionId,ctx.principal.personId,
   {...actor,intentId:body.intent_id,approvalId:body.approval_id,reversalDate:body.reversalDate,reason:body.reason});
  return{reversed:true,...result};
 }
 const material=await loadBankAllocationIntent(ctx,body.intent_id);
 if(material.plan.bankTransactionId!==body.bankTransactionId||((body.action==='split_allocate')!==(material.plan.kind==='split')))throw new Error('Prepared allocation does not match request');
 const result=await executeBankAllocation(ctx,body.intent_id,{...actor,approvalId:body.approval_id});
 const [row]=await ctx.sql`SELECT * FROM bank_transactions WHERE company_id=${company}::uuid AND id=${body.bankTransactionId}::uuid` as DbRow[];
 if(!row)throw new Error('Bank allocation result unavailable');
 return{...result,bankTransaction:mapTxRow(row)};
}
