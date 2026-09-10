/** Shared immutable bank allocation adapters. All financial effects use the approved parent service. */
import {preparePartyBankAllocation} from './bankAllocationDefaultPreparation';
import {isBankAllocationRefund} from './bankAllocationPlan';
import Decimal from 'decimal.js';
const D=Decimal.clone({precision:80});
import {withSavepoint} from '@/lib/neon';
import type {DbRow} from '@/lib/neon';
import {resolveReversalDate} from '../gl/journalEntryService';
import type {PostingActorOpts} from '../gl/journalEntryMeta';
import {requireControlTx} from '../controls/context';
import {assertEffectivePermission} from '@/lib/auth/effectivePermissions';
import {mapTxRow} from './bankTransactionQueryService';
import type {BankAllocationUnwindResult} from './bankAllocationUnwind';
import {prepareBankAllocation,executeBankAllocation} from './bankAllocationControl';
type Row=DbRow;
export type AllocationType='account'|'supplier'|'customer'|'transfer';
export interface SplitLine {contraAccountId:string;amount:number;description?:string;vatCode?:string}
export type BankAllocationOptions=PostingActorOpts&{autoApply?:boolean;intentId?:string;approvalId?:string;applications?:{invoiceId:string;amount:string}[]};
async function actor(companyId:string,userId:string){
 const ctx=requireControlTx();if(ctx.principal.companyId!==companyId||ctx.principal.personId!==userId)throw new Error('Bank allocation actor mismatch');
 await assertEffectivePermission(ctx,'write:bank-tx');await assertEffectivePermission(ctx,'write:post');
 await ctx.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`control-policy:${companyId}`},0))`;return ctx;
}
async function runPlan(companyId:string,bankTxId:string,userId:string,input:unknown,opts?:BankAllocationOptions){
 const ctx=await actor(companyId,userId);
 return withSavepoint('bank_allocation_adapter',async()=>{
  let intentId=opts?.intentId;
  if(intentId){
   const rows=await ctx.sql`SELECT id FROM control_bank_allocation_intents WHERE company_id=${companyId}::uuid AND id=${intentId}::uuid AND bank_transaction_id=${bankTxId}::uuid`;
   if(rows.length!==1)throw new Error('Owned matching allocation intent required');
  }else intentId=(await prepareBankAllocation(ctx,input)).intentId;
  const result=await executeBankAllocation(ctx,intentId,opts);
  const [row]=await ctx.sql`SELECT * FROM bank_transactions WHERE company_id=${companyId}::uuid AND id=${bankTxId}::uuid` as Row[];
  if(!row)throw new Error('Bank allocation result unavailable');
  return{journalEntryId:result.journalEntryId,bankTransaction:mapTxRow(row)};
 });
}
export async function allocateTransaction(companyId:string,bankTxId:string,contraAccountId:string|null,userId:string,
 description?:string,allocType:AllocationType='account',entityId?:string,vatCode?:string,cc1Id?:string,cc2Id?:string,buId?:string,invoiceId?:string,opts?:BankAllocationOptions){
 const ctx=await actor(companyId,userId);
 if(allocType==='transfer'){
  if(!contraAccountId||entityId||invoiceId||cc1Id||cc2Id||buId||opts?.applications?.length||(vatCode&&vatCode!=='none'))throw new Error('Transfer requires a bank counterparty without VAT, dimensions or applications');
  return runPlan(companyId,bankTxId,userId,{version:1,kind:'transfer',bankTransactionId:bankTxId,counterpartyAccountId:contraAccountId,description},opts);
 }
 const [bank]=await ctx.sql`SELECT amount::text FROM bank_transactions WHERE company_id=${companyId}::uuid AND id=${bankTxId}::uuid FOR UPDATE` as {amount:string}[];
 if(!bank)throw new Error('Owned bank transaction not found');
 const amount=new D(bank.amount).abs().toFixed();
 const common={version:1,kind:allocType,bankTransactionId:bankTxId,description};
 let input:unknown;
 if(allocType==='customer'||allocType==='supplier'){
  if(!entityId)throw new Error('Owned allocation party required');
  const refund=isBankAllocationRefund(allocType,bank.amount);
  if(refund&&(invoiceId||opts?.applications?.length))throw new Error('Refund applications must be empty');
  input={...common,partyId:entityId,cc1Id,cc2Id,buId,applications:opts?.applications??(invoiceId?[{invoiceId,amount}]:[])};
  if(!opts?.intentId)return withSavepoint('bank_default_adapter',async()=>{
   const prepared=await preparePartyBankAllocation(ctx,{kind:allocType,bankTransactionId:bankTxId,partyId:entityId,description,cc1Id,cc2Id,buId,
    autoApply:opts?.autoApply,applications:opts?.applications??(invoiceId?[{invoiceId,amount}]:undefined)});
   return runPlan(companyId,bankTxId,userId,input,{...opts,intentId:prepared.intentId});
  });
 }else input={...common,lines:[{accountId:contraAccountId,amount,vatCode:vatCode??'none',cc1Id,cc2Id,buId}]};
 return runPlan(companyId,bankTxId,userId,input,opts);
}
export async function splitAllocateTransaction(companyId:string,bankTxId:string,lines:SplitLine[],userId:string,opts?:BankAllocationOptions){
 return runPlan(companyId,bankTxId,userId,{version:1,kind:'split',bankTransactionId:bankTxId,
  lines:lines.map(line=>({accountId:line.contraAccountId,amount:String(line.amount),description:line.description,vatCode:line.vatCode??'none'}))},opts);
}

export async function reverseReconciledTransaction(companyId:string,bankTxId:string,userId:string,
 opts?:PostingActorOpts&{reversalDate?:string;intentId?:string;approvalId?:string;reason?:string}):Promise<BankAllocationUnwindResult>{
 const ctx=await actor(companyId,userId);
 return withSavepoint('bank_reversal_adapter',async()=>{
  const {prepareBankAllocationReversal,executeBankAllocationReversal}=await import('./bankAllocationReversal');
  let intentId=opts?.intentId;
  if(intentId){
   const rows=await ctx.sql`SELECT id FROM control_bank_allocation_reversal_intents WHERE company_id=${companyId}::uuid AND id=${intentId}::uuid AND bank_transaction_id=${bankTxId}::uuid`;
   if(rows.length!==1)throw new Error('Owned matching bank reversal intent required');
  }else{
   const [original]=await ctx.sql`SELECT i.id,i.accounting_date::text FROM control_bank_allocation_intents i JOIN control_operation_effects e
    ON e.company_id=i.company_id AND lower(e.entity_id)=i.id::text AND e.entity_type='bank_allocation_intent' AND e.operation='bank_allocation.post'
    WHERE i.company_id=${companyId}::uuid AND i.bank_transaction_id=${bankTxId}::uuid ORDER BY e.committed_at DESC LIMIT 1` as {id:string;accounting_date:string}[];
   if(!original)throw new Error('Legacy bank allocation requires explicit verified provenance before reversal');
   const reversalDate=await resolveReversalDate(companyId,original.accounting_date,opts?.reversalDate);
   intentId=(await prepareBankAllocationReversal(ctx,{originalIntentId:original.id,reversalDate,reason:opts?.reason??'Bank allocation correction'})).intentId;
  }
  return executeBankAllocationReversal(ctx,intentId,opts);
 });
}
