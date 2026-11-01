/**
 * Undo on the bank transactions page (master plan U, decision 4). Offered after a single-row allocate and after
 * excluding an `imported` line. Never after a transfer, a match, a bulk review or a batch: see the wave-3 spec.
 *
 * The reversal is `reverse`, unchanged, so forensic controls and journal-date refusals may refuse it, and the
 * server's sentence is what the user reads. It unwinds what `autoApply: 'fifo'` settled, and leaves what the
 * categoriser learned.
 *
 * Both undos state what they expect (the journal, the `excluded` status) and the server refuses under the row lock
 * if the line has moved on: this client's re-read leaves a gap before the write, and a toast can be 8 s old or older.
 */

import { apiFetch, assertOk, apiErrorMessage } from '@/lib/apiFetch';
import { notify } from '@/utils/toast';
import type { BankTx } from '@/components/accounting/BankTxTable';
import { LINE_CHANGED_MESSAGE } from '@/modules/accounting/services/bank/bankTxStatusErrors';

const LEARNING_KEPT_MESSAGE = 'Undo reverses the journal. What was learned from this allocation is kept.';

interface UndoContext {
  callAction: (body: Record<string, string>) => Promise<unknown>;
  /** Reloads what is on screen when the undo finishes, which may not be the view that offered it. */
  reloadCurrentView: () => void;
}

/**
 * The journal this line is matched to now, or null. There is no read of one line by id, so this asks the list for
 * the line's own date and amount; a line that left the New tab's statuses is not found, and that is a change too.
 */
async function currentJournalOf(tx: BankTx, bankAccountId: string): Promise<string | null> {
  const params = new URLSearchParams({
    bank_account_id: bankAccountId, status: 'imported', limit: '100',
    from_date: tx.transactionDate, to_date: tx.transactionDate,
    from_amount: String(tx.amount), to_amount: String(tx.amount),
  });
  const res = await apiFetch(`/api/accounting/bank-transactions?${params}`);
  await assertOk(res, 'Could not check the line - try again');
  const json = await res.json() as { data?: { transactions?: Pick<BankTx, 'id' | 'matchedJournalEntryId'>[] } };
  return json.data?.transactions?.find((t) => t.id === tx.id)?.matchedJournalEntryId ?? null;
}

export function offerAllocationUndo(tx: BankTx, bankAccountId: string, journalEntryId: string, ctx: UndoContext): void {
  notify.undoable('Transaction allocated', {
    message: LEARNING_KEPT_MESSAGE,
    onUndo: async () => {
      try {
        if (await currentJournalOf(tx, bankAccountId) !== journalEntryId) {
          notify.error(LINE_CHANGED_MESSAGE);
          ctx.reloadCurrentView();
          return;
        }
        await ctx.callAction({ action: 'reverse', bankTransactionId: tx.id, expectedJournalEntryId: journalEntryId });
        notify.success('Allocation undone');
        ctx.reloadCurrentView();
      } catch (e) { notify.error(apiErrorMessage(e, 'Could not undo the allocation - try again')); }
    },
  });
}

/** Only for a line that was `imported`: `unmatch` sets `imported` whatever the line was before. */
export function offerExcludeUndo(txId: string, ctx: UndoContext): void {
  notify.undoable('Transaction excluded', {
    onUndo: async () => {
      try {
        await ctx.callAction({ action: 'unmatch', bankTransactionId: txId, expectedStatus: 'excluded' });
        notify.success('Transaction restored');
        ctx.reloadCurrentView();
      } catch (e) { notify.error(apiErrorMessage(e, 'Could not restore the transaction - try again')); }
    },
  });
}
