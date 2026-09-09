/** Shared immutable bank allocation adapters. All financial effects use the approved parent service. */
import Decimal from 'decimal.js';
import {sql,withSavepoint} from '@/lib/neon';
import {fmtDate} from '@/lib/fmtDate';
import {log} from '@/lib/logger';
import type {DbRow} from '@/lib/neon';
import {resolveReversalDate} from '../gl/journalEntryService';
import {getPeriodStatusForDate} from '../gl/periodStatusService';
import type {PostingActorOpts} from '../gl/journalEntryMeta';
import {requireControlTx} from '../controls/context';
import {assertEffectivePermission} from '@/lib/auth/effectivePermissions';
import {mapTxRow} from './bankTransactionQueryService';
import {lockBankTransactionForUpdate} from './bankTxLock';
import {unwindBankAllocationApplication,type BankAllocationUnwindResult} from './bankAllocationUnwind';
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
  const result=await executeBankAllocation(ctx,intentId,{approvalId:opts?.approvalId});
  const [row]=await ctx.sql`SELECT * FROM bank_transactions WHERE company_id=${companyId}::uuid AND id=${bankTxId}::uuid` as Row[];
  if(!row)throw new Error('Bank allocation result unavailable');
  return{journalEntryId:result.journalEntryId,bankTransaction:mapTxRow(row)};
 });
}
export async function allocateTransaction(companyId:string,bankTxId:string,contraAccountId:string|null,userId:string,
 description?:string,allocType:AllocationType='account',entityId?:string,vatCode?:string,cc1Id?:string,cc2Id?:string,buId?:string,invoiceId?:string,opts?:BankAllocationOptions){
 const ctx=await actor(companyId,userId);
 if(allocType==='transfer')throw new Error('Bank transfers require the dedicated immutable transfer intent');
 const [bank]=await ctx.sql`SELECT amount::text FROM bank_transactions WHERE company_id=${companyId}::uuid AND id=${bankTxId}::uuid FOR UPDATE` as {amount:string}[];
 if(!bank)throw new Error('Owned bank transaction not found');
 const amount=new Decimal(bank.amount).abs().toFixed();
 const common={version:1,kind:allocType,bankTransactionId:bankTxId,description};
 let input:unknown;
 if(allocType==='customer'||allocType==='supplier'){
  if(!entityId)throw new Error('Owned allocation party required');
  if(!opts?.applications&&!invoiceId&&opts?.autoApply!==false){
   const rows=allocType==='customer'?await ctx.sql`SELECT auto_allocate_strategy FROM customers WHERE company_id=${companyId}::uuid AND id=${entityId}::uuid`
    :await ctx.sql`SELECT auto_allocate_strategy FROM suppliers WHERE company_id=${companyId}::uuid AND id=${entityId}::uuid`;
   const strategy=(rows as {auto_allocate_strategy:string|null}[])[0]?.auto_allocate_strategy;
   if(strategy&&strategy!=='off')throw new Error('Prepare explicit immutable auto-allocation applications before posting');
  }
  input={...common,partyId:entityId,applications:opts?.applications??(invoiceId?[{invoiceId,amount}]:[])};
 }else input={...common,lines:[{accountId:contraAccountId,amount,vatCode:vatCode??'none',cc1Id,cc2Id,buId}]};
 return runPlan(companyId,bankTxId,userId,input,opts);
}
export async function splitAllocateTransaction(companyId:string,bankTxId:string,lines:SplitLine[],userId:string,opts?:BankAllocationOptions){
 return runPlan(companyId,bankTxId,userId,{version:1,kind:'split',bankTransactionId:bankTxId,
  lines:lines.map(line=>({accountId:line.contraAccountId,amount:String(line.amount),description:line.description,vatCode:line.vatCode??'none'}))},opts);
}

async function assertReversalDatePostable(
  companyId: string, journalEntryId: string, requested: string | undefined,
): Promise<void> {
  const rows = (await sql`
    SELECT entry_date FROM gl_journal_entries
    WHERE id = ${journalEntryId}::UUID AND company_id = ${companyId}::UUID`) as Row[];
  if (rows.length === 0) throw new Error('Cannot reverse: journal entry not found');
  const originalDate = fmtDate(rows[0]!.entry_date as string | Date);
  const reversalDate = await resolveReversalDate(companyId, originalDate, requested);
  const status = await getPeriodStatusForDate(companyId, reversalDate);
  // `closed` ONLY — `no_period` is deliberately allowed through. createJournalEntry
  // calls ensureFiscalPeriodForDate, which CREATES the fiscal year on demand for
  // any year inside the auto-create window, and the only uncovered date that can
  // reach here is today: resolveReversalDate has already proven an explicit date
  // open, and its default arm returns either an open original date or today.
  // Today is always inside that window, so refusing here would turn a reversal
  // that used to auto-create its year into a 400 — the one outcome
  // fiscalPeriodAutoCreate.ts was written to avoid. A guard fronting a write must
  // refuse only what the write itself refuses.
  if (status !== 'closed') return;
  // getPeriodStatusForDate reports 'closed' for a LOCKED period too, so the
  // message names both rather than telling someone to re-open a locked period.
  throw new Error(
    `Cannot reverse: the fiscal period covering ${reversalDate} is not open (closed or locked). `
    + 'Re-open it before reversing.',
  );
}

/**
 * Undo an allocation: post the contra for the matched journal, then return the
 * bank transaction to 'imported'.
 *
 * `opts.postingAgent` is forwarded to the contra journal so an automated caller
 * (MCP) can attribute its own correction. Omitting opts — every REST and
 * auto-post-undo call site — leaves the contra on the `human:<userId>` default.
 */
export async function reverseReconciledTransaction(
  companyId: string, bankTxId: string, userId: string,
  opts?: PostingActorOpts & { reversalDate?: string },
): Promise<BankAllocationUnwindResult> {
  const tx = await lockBankTransactionForUpdate(companyId, bankTxId); // see allocateTransaction
  if (!tx) throw new Error('Transaction not found');
  if (tx.status !== 'allocated' && tx.status !== 'matched' && tx.status !== 'reconciled') {
    throw new Error('Can only reverse allocated, matched, or reconciled transactions');
  }
  let journalEntryId: string | null = null;
  if (tx.matched_journal_line_id) {
    const jlRows = (await sql`
      SELECT jl.journal_entry_id FROM gl_journal_lines jl
      WHERE jl.id = ${tx.matched_journal_line_id}::UUID AND jl.company_id = ${companyId}::UUID`) as Row[];
    if (jlRows.length > 0 && jlRows[0]!.journal_entry_id) {
      journalEntryId = String(jlRows[0]!.journal_entry_id);
      // Read-only, and before the first write of this function.
      await assertReversalDatePostable(companyId, journalEntryId, opts?.reversalDate);
    }
  }

  // Every WRITE below runs inside one savepoint. The unwind has to precede the
  // contra (see the comment on it), so without this a throw from the contra
  // leaves the subledger unwound with the cash journal still standing — and a
  // 400 from the route COMMITs that. Rolling the pair back together is what
  // makes a refusal mean "nothing happened"; the bank-line reset joins them so
  // a failure there cannot strand a reset line either.
  //
  // This depends on there BEING a request transaction: withSavepoint degrades to
  // a bare fn() outside one, and each bare `sql` then auto-commits on its own.
  // lockBankTransactionForUpdate above throws outside a request transaction, so
  // no caller can reach this line without one — that refusal is what keeps this
  // guarantee true, and a future cron caller would hit it rather than silently
  // getting the pre-fix behaviour back.
  const unwound = await withSavepoint('bank_reverse_reconciled', async () => {
    let result: BankAllocationUnwindResult = {
      invoicesReopened: 0, amountUnapplied: 0, paymentsCancelled: 0,
    };
    if (journalEntryId) {
      // BEFORE the contra is posted, not after. A line that named an invoice
      // moved the subledger; reversing the journal while that stands returns
      // the credit to the control account with the invoice still reading as
      // settled, which widens the subledger-to-control gap behind an
      // ordinary-looking reversal.
      result = await unwindBankAllocationApplication(companyId, journalEntryId);
      const { reverseJournalEntry } = await import('../gl/journalEntryService');
      try {
        await reverseJournalEntry(companyId, journalEntryId, userId, opts);
      } catch (e) {
        throw new Error(`Cannot reverse: ${e instanceof Error ? e.message : 'Journal reversal failed'}`);
      }
    }

    // Reset the bank transaction. If this fails after a successful GL reversal,
    // log the inconsistency; the savepoint then takes the reversal back with it.
    try {
      await sql`
        UPDATE bank_transactions
        SET status = 'imported', matched_journal_line_id = NULL, reconciliation_id = NULL,
            linked_po_id = NULL, allocation_type = NULL, allocated_entity_name = NULL,
            allocation_rule_id = NULL, allocation_rule_name = NULL,
            -- Reversing one line takes it OUT of its batch: the batch no longer
            -- owns a journal here, and a later re-allocation must not be swept
            -- up by reverse_bank_allocation_batch.
            allocation_batch_id = NULL,
            updated_at = NOW()
        WHERE id = ${bankTxId}::UUID AND company_id = ${companyId}::UUID`;
    } catch (resetErr) {
      log.error('Bank transaction reset failed after GL reversal — rolling the reversal back',
        { bankTxId, journalEntryId, error: resetErr }, 'accounting');
      throw resetErr;
    }
    return result;
  });
  log.info('Reversed reconciled bank transaction', { bankTxId, userId }, 'accounting');
  // Reported rather than discarded: `void_receipt` delegates to this function
  // and previously had to answer "0 invoices reopened" for the branch that does
  // the MOST work, because the counts were computed here and thrown away. An
  // agent reading that reply concludes nothing was undone and re-applies the
  // receipt. Callers that do not care keep ignoring the return value.
  return unwound;
}
