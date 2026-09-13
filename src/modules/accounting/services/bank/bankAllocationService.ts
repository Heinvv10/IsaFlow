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
/** What both reversal effects actually return: the unwind counts plus the journals the reversal touched. */
export type BankAllocationReversalResult=BankAllocationUnwindResult&{bankTransactionId:string;originalJournalEntryId:string;reversalJournalEntryId:string};
import {prepareBankAllocation,executeBankAllocation} from './bankAllocationControl';
type Row=DbRow;
export type AllocationType='account'|'supplier'|'customer'|'transfer';
export interface SplitLine {contraAccountId:string;amount:number;description?:string;vatCode?:string}
export type BankAllocationOptions=PostingActorOpts&{autoApply?:boolean;intentId?:string;approvalId?:string;applications?:{invoiceId:string;amount:string}[];
 /** The bank-rule sweep's attribution; the plan carries it so the receipt covers it (a later UPDATE would change the fingerprint). */
 rule?:{id:string;name:string}};
/** The authority every bank allocation asserts, callable by a preview that skips only the write. */
export async function assertBankAllocationAuthority(companyId:string,userId:string){
 const ctx=requireControlTx();if(ctx.principal.companyId!==companyId||ctx.principal.personId!==userId)throw new Error('Bank allocation actor mismatch');
 await assertEffectivePermission(ctx,'write:bank-tx');await assertEffectivePermission(ctx,'write:post');
 return ctx;
}
async function actor(companyId:string,userId:string){
 const ctx=await assertBankAllocationAuthority(companyId,userId);
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
 const common={version:1,kind:allocType,bankTransactionId:bankTxId,description,rule:opts?.rule};
 let input:unknown;
 if(allocType==='customer'||allocType==='supplier'){
  if(!entityId)throw new Error('Owned allocation party required');
  const refund=isBankAllocationRefund(allocType,bank.amount);
  if(refund&&(invoiceId||opts?.applications?.length))throw new Error('Refund applications must be empty');
  input={...common,partyId:entityId,cc1Id,cc2Id,buId,applications:opts?.applications??(invoiceId?[{invoiceId,amount}]:[])};
  if(!opts?.intentId)return withSavepoint('bank_default_adapter',async()=>{
   const prepared=await preparePartyBankAllocation(ctx,{kind:allocType,bankTransactionId:bankTxId,partyId:entityId,description,cc1Id,cc2Id,buId,
    autoApply:opts?.autoApply,rule:opts?.rule,applications:opts?.applications??(invoiceId?[{invoiceId,amount}]:undefined)});
   return runPlan(companyId,bankTxId,userId,input,{...opts,intentId:prepared.intentId});
  });
 }else input={...common,lines:[{accountId:contraAccountId,amount,vatCode:vatCode??'none',cc1Id,cc2Id,buId}]};
 return runPlan(companyId,bankTxId,userId,input,opts);
}
/**
 * The unattended provisional posting: the import sweep's predictor coded this line, so it goes through the SAME
 * controlled allocation a person performs on the screen — one intent, one receipt, a parented generated journal and
 * every refusal the controlled path raises — and lands the row in the evidence-review queue rather than as an
 * allocated one. A bare postJournalEntry here carried 'auto_bank_recon', which the kernel refuses as a direct
 * operation on a generated journal, and took the whole statement import down with a 500.
 */
export async function allocateProvisionalTransaction(companyId:string,bankTxId:string,contraAccountId:string,userId:string,
 prediction:{predictedSupplierId?:string;confidence:number},description?:string,vatCode?:string,opts?:BankAllocationOptions){
 const ctx=await actor(companyId,userId);
 const [bank]=await ctx.sql`SELECT amount::text FROM bank_transactions WHERE company_id=${companyId}::uuid AND id=${bankTxId}::uuid FOR UPDATE` as {amount:string}[];
 if(!bank)throw new Error('Owned bank transaction not found');
 const amount=new D(bank.amount).abs().toFixed();
 return runPlan(companyId,bankTxId,userId,{version:1,kind:'account',bankTransactionId:bankTxId,description,
  lines:[{accountId:contraAccountId,amount,vatCode:vatCode??'none'}],
  provisional:{...(prediction.predictedSupplierId?{predictedSupplierId:prediction.predictedSupplierId}:{}),confidence:prediction.confidence}},opts);
}
export async function splitAllocateTransaction(companyId:string,bankTxId:string,lines:SplitLine[],userId:string,opts?:BankAllocationOptions){
 return runPlan(companyId,bankTxId,userId,{version:1,kind:'split',bankTransactionId:bankTxId,
  lines:lines.map(line=>({accountId:line.contraAccountId,amount:String(line.amount),description:line.description,vatCode:line.vatCode??'none'}))},opts);
}

/**
 * Reverse the provisional entry a bank line names — dismiss, and the auto-post run undo.
 *
 * Both used to call reverseJournalEntry directly, which the kernel refuses because the journal carries a generated
 * source, and the refusal poisons the request: every provisional entry in the ledger was undismissable. This routes
 * through the controlled reversal of the OWNING allocation, which honours its approval policy either way:
 *   - an entry posted through the controlled allocation reverses against its own receipt;
 *   - an entry that PREDATES the controls has no receipt, so the reversal names the journal whose provenance is proven
 *     from the data instead (bankAllocationLegacyProvisional) — the population production already holds.
 */
export async function reverseProvisionalEntry(companyId:string,journalEntryId:string,userId:string,
 opts?:PostingActorOpts&{reversalDate?:string;reason?:string}):Promise<{bankTransactionId:string;reversalJournalEntryId:string}>{
 const ctx=await actor(companyId,userId);
 const [bank]=await ctx.sql`SELECT id,transaction_date::text AS transaction_date FROM bank_transactions
  WHERE company_id=${companyId}::uuid AND provisional_je_id=${journalEntryId}::uuid` as Row[];
 if(!bank)throw new Error('No bank transaction names this provisional journal');
 const bankTxId=String(bank.id);
 const receipted=await ctx.sql`SELECT i.id FROM control_bank_allocation_intents i
  JOIN control_operation_effects e ON e.company_id=i.company_id AND e.entity_type='bank_allocation_intent'
   AND e.entity_id_canonical=i.id::text AND e.operation='bank_allocation.post'
  WHERE i.company_id=${companyId}::uuid AND i.bank_transaction_id=${bankTxId}::uuid` as Row[];
 if(receipted.length){
  const result=await reverseReconciledTransaction(companyId,bankTxId,userId,opts);
  return{bankTransactionId:bankTxId,reversalJournalEntryId:result.reversalJournalEntryId};
 }
 return withSavepoint('bank_legacy_reversal_adapter',async()=>{
  const {prepareBankAllocationReversal,executeBankAllocationReversal}=await import('./bankAllocationReversal');
  const reversalDate=await resolveReversalDate(companyId,String(bank.transaction_date),opts?.reversalDate);
  const {intentId}=await prepareBankAllocationReversal(ctx,{legacyJournalEntryId:journalEntryId,reversalDate,
   reason:opts?.reason??'Provisional entry dismissed'});
  const result=await executeBankAllocationReversal(ctx,intentId,opts);
  return{bankTransactionId:bankTxId,reversalJournalEntryId:result.reversalJournalEntryId};
 });
}
export async function reverseReconciledTransaction(companyId:string,bankTxId:string,userId:string,
 opts?:PostingActorOpts&{reversalDate?:string;intentId?:string;approvalId?:string;reason?:string}):Promise<BankAllocationReversalResult>{
 const ctx=await actor(companyId,userId);
 return withSavepoint('bank_reversal_adapter',async()=>{
  const {prepareBankAllocationReversal,executeBankAllocationReversal}=await import('./bankAllocationReversal');
  let intentId=opts?.intentId;
  if(intentId){
   const rows=await ctx.sql`SELECT id FROM control_bank_allocation_reversal_intents WHERE company_id=${companyId}::uuid AND id=${intentId}::uuid AND bank_transaction_id=${bankTxId}::uuid`;
   if(rows.length!==1)throw new Error('Owned matching bank reversal intent required');
  }else{
   const [original]=await ctx.sql`SELECT i.id,i.accounting_date::text FROM control_bank_allocation_intents i JOIN LATERAL(SELECT e.committed_at FROM control_operation_effects e
    WHERE e.company_id=i.company_id AND e.entity_id_canonical=i.id::text AND e.entity_type='bank_allocation_intent' AND e.operation='bank_allocation.post' OFFSET 0) e ON true
    WHERE i.company_id=${companyId}::uuid AND i.bank_transaction_id=${bankTxId}::uuid ORDER BY e.committed_at DESC LIMIT 1` as {id:string;accounting_date:string}[];
   if(!original)throw new Error('Legacy bank allocation requires explicit verified provenance before reversal');
   const reversalDate=await resolveReversalDate(companyId,original.accounting_date,opts?.reversalDate);
   intentId=(await prepareBankAllocationReversal(ctx,{originalIntentId:original.id,reversalDate,reason:opts?.reason??'Bank allocation correction'})).intentId;
  }
  return executeBankAllocationReversal(ctx,intentId,opts);
 });
}
