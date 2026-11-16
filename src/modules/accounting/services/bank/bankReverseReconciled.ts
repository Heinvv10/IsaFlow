/**
 * Reverse one bank line's allocation (the choke point every reversal path goes through). Moved
 * verbatim out of bankAllocationService.ts (its line cap), which re-exports it for every existing
 * import site.
 */

import { reconciliationLockOf, refuseLockedCash } from './reconciledCash';
import { withSavepoint } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { PostingActorOpts } from '../gl/journalEntryMeta';
import { unwindBankAllocationApplication } from './bankAllocationUnwind';
import type { BankAllocationUnwindResult } from './bankAllocationUnwind';
import { lockBankTransactionForUpdate } from './bankTxLock';
import { assertReversalDatePostable, entryDateOf, lockPeekedReversalTarget, peekReversalTarget } from './reversalDatePostable';
import { underFlowLockBudget } from '../core/rowLockBudget';
import { refuseResettingProvisionalLine } from './provisionalLineGuard';
import { isoDay, lockChainLines, peekLineChain, refuseStaleUndo, resetBankLine, reverseDocumentChainLine } from './bankChainLineReversal';
import { BankAllocationRefusal } from './bankAllocationRefusal';
import { assertMayReverse, auditedReversal } from './bankReversalGate';
import { postingRefOf, recordAutoPostUndone } from './codingDecisionLog';

// ── Reverse Reconciled ────────────────────────────────────────────────────────

/**
 * Undo an allocation: post the contra for the matched journal, then return the
 * bank transaction to 'imported'.
 *
 * `opts.postingAgent` is forwarded to the contra journal so an automated caller
 * (MCP) can attribute its own correction. Omitting opts — every REST and
 * auto-post-undo call site — leaves the contra on the `human:<userId>` default.
 */
export async function reverseReconciledTransaction(
  companyId: string, bankTxId: string, userId: string, opts?: PostingActorOpts & { reversalDate?: string; expectedJournalEntryId?: string },
): Promise<BankAllocationUnwindResult> { // every lock under ONE budget, plain UPDATEs included (D8 round 10)
  return underFlowLockBudget(`Bank transaction ${bankTxId}`, () => reverseReconciledInner(companyId, bankTxId, userId, opts));
}
async function reverseReconciledInner(
  companyId: string, bankTxId: string, userId: string, opts?: PostingActorOpts & { reversalDate?: string; expectedJournalEntryId?: string },
): Promise<BankAllocationUnwindResult> {
  // D10: the line's journal is read through its chain's ROOT, which a document carries. A document's chain has every
  // statement line of it locked FIRST, in id order with this one (bank/bankChainLineReversal), as the HTTP void does.
  // An undo locks them on any chain: it refuses if this line is not the only one.
  const chain = await peekLineChain(companyId, bankTxId);
  const undoing = opts?.expectedJournalEntryId;
  const chainLines = chain && (chain.doc || undoing) ? await lockChainLines(companyId, chain) : [];
  const tx = await lockBankTransactionForUpdate(companyId, bankTxId); // see allocateTransaction
  if (!tx) throw new BankAllocationRefusal('Transaction not found');
  // D10 O9 (with R-127's settled case): a provisional's own line is refused while its journal stands; one whose
  // journal the GL already took out is only freed below, its link cleared, nothing posted.
  const deadProvisional = await refuseResettingProvisionalLine(companyId, tx, 'reverse');
  // Changed since the peek (matched, unmatched or re-matched by another request): a state conflict, nothing written,
  // 409 — before the status refusal, which would otherwise answer an unmatch in between as a 400.
  if (String(tx.matched_journal_line_id ?? '') !== (chain?.lineId ?? '')) {
    throw new BankAllocationRefusal('This bank line was changed by another request while it was being reversed — retry in a moment.',
      undefined, { retryable: true });
  }
  await refuseStaleUndo(companyId, bankTxId, chain, undoing); // the page's Undo: the journal it offered, or nothing
  if (!deadProvisional && tx.status !== 'allocated' && tx.status !== 'matched' && tx.status !== 'reconciled') {
    throw new BankAllocationRefusal('Can only reverse allocated, matched, or reconciled transactions');
  }
  // Cash on a COMPLETED reconciliation (or reconciled in the Sage import) is
  // locked — the shared rule void and batch reversal apply. Reversing it here
  // changed a completed reconciliation's figures with the reconciliation still
  // reading "completed". Before any write, so every caller answers it 400.
  refuseLockedCash(await reconciliationLockOf(companyId, tx), 'This bank line');
  const clearance = await assertMayReverse(companyId, tx, chain?.rootId ?? null, userId); // step 2: pre-write; audited after
  // Learning loop: the line's posting before the reversal, so only an auto-post that IS that posting is undone.
  const postingBefore = postingRefOf(tx);
  if (chain?.doc) {
    const docResult = await auditedReversal(companyId, bankTxId, userId, clearance,
      await reverseDocumentChainLine(companyId, tx, { ...chain, doc: chain.doc }, chainLines, userId, opts));
    await recordAutoPostUndone(companyId, bankTxId, userId, postingBefore); // non-fatal
    return docResult;
  }
  // A plain journal: its chain decided from the root (D10), so a line on a middle or head reversal reverses the head
  // exactly when the chain stands. Its other lines stay as they are (a transfer's second leg: not D10).
  const journalEntryId = chain?.rootId ?? null;
  const reverseId = journalEntryId ? await peekReversalTarget(companyId, journalEntryId) : null; // locked after the unwind
  if (reverseId) await assertReversalDatePostable(companyId, reverseId, opts?.reversalDate); // read-only, pre-write
  // The contra defaults to the date of the journal it reverses (D8: the chain head); date_moved compares to it.
  const originalEntryDate = journalEntryId ? isoDay(await entryDateOf(companyId, reverseId ?? journalEntryId)) : null;

  // Every WRITE below runs inside one savepoint. The unwind has to precede the
  // contra (see the comment on it), so without this a throw from the contra
  // leaves the subledger unwound with the cash journal still standing — and a
  // 400 from the route COMMITs that. Rolling the pair back together is what
  // makes a refusal mean "nothing happened"; the bank-line reset joins them so
  // a failure there cannot strand a reset line either.
  //
  // This depends on there BEING a request transaction (withSavepoint degrades to a bare fn() outside one);
  // lockBankTransactionForUpdate above throws outside one, which is what keeps this guarantee true.
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
      await lockPeekedReversalTarget(companyId, journalEntryId, reverseId); // the journal locked last (D8 round 6)
      await refuseStaleUndo(companyId, bankTxId, chain, undoing); // this savepoint takes the unwind back with it
      const { reverseJournalEntry } = await import('../gl/journalEntryService');
      try {
        const reversal = reverseId ? await reverseJournalEntry(companyId, reverseId, userId, opts) : null;
        // Carried out so reverse_bank_allocation / void_receipt can say the contra was dated past a locked VAT
        // period and, with the two dates, that a CLOSED fiscal period moved it to today
        // (2026-10-02: nine April-2025 contras landed in October while the reply
        // said nothing had moved). A chain already out (D8) posts no contra: no date.
        result = {
          ...result, vatLockRoll: reversal?.vatLockRoll ?? null,
          originalEntryDate, reversalEntryDate: reversal ? isoDay(reversal.entryDate) : null,
        };
      } catch (e) {
        // A CODED refusal (VatPeriodLockedError and its kin: a string code that
        // is not a 5-character SQLSTATE) passes through as itself — rewrapped,
        // it lost the class routes map to 4xx and the code MCP surfaces.
        const code = (e as { code?: unknown } | null)?.code;
        if (e instanceof Error && typeof code === 'string' && !/^[0-9A-Z]{5}$/.test(code)) throw e;
        throw new Error(`Cannot reverse: ${e instanceof Error ? e.message : 'Journal reversal failed'}`);
      }
    }

    // Reset the bank transaction. If this fails after a successful GL reversal,
    // log the inconsistency; the savepoint then takes the reversal back with it.
    try {
      await resetBankLine(companyId, bankTxId, deadProvisional);
    } catch (resetErr) {
      log.error('Bank transaction reset failed after GL reversal — rolling the reversal back',
        { bankTxId, journalEntryId, error: resetErr }, 'accounting');
      throw resetErr;
    }
    return result;
  });
  log.info('Reversed reconciled bank transaction', { bankTxId, userId }, 'accounting');
  await auditedReversal(companyId, bankTxId, userId, clearance, null);
  await recordAutoPostUndone(companyId, bankTxId, userId, postingBefore); // non-fatal
  // Reported rather than discarded: `void_receipt` delegates to this function
  // and previously had to answer "0 invoices reopened" for the branch that does
  // the MOST work, because the counts were computed here and thrown away. An
  // agent reading that reply concludes nothing was undone and re-applies the
  // receipt. Callers that do not care keep ignoring the return value.
  return unwound;
}
