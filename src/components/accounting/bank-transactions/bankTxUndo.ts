/**
 * Undo on the bank transactions page (master plan U, decision 4). Offered after a single-row allocate of an account or
 * a supplier, and after excluding a line the server says was `imported`. Never after a customer line, a transfer (or an
 * account allocation to a bank, which is one), a match, a bulk review or a batch: see the wave-3 spec and PR U's notes.
 *
 * The reversal is `reverse`, unchanged, so forensic controls and journal-date refusals may refuse it, and the
 * server's sentence is what the user reads. It unwinds what `autoApply: 'fifo'` settled, and leaves what the
 * categoriser learned.
 *
 * Both undos state what they expect (the journal, the `excluded` status) and the server refuses under the row lock
 * if the line has moved on, so nothing here reads the line first: a toast can be 8 s old or older, and any read of
 * ours leaves a gap before the write.
 */

import { apiErrorMessage } from '@/lib/apiFetch';
import { notify } from '@/utils/toast';
import { formatDisplayDate } from '@/utils/dateFormat';
import type { RowSelection } from '@/components/accounting/BankTxTable';

const LEARNING_KEPT_MESSAGE = 'Undo reverses the journal. What was learned from this allocation is kept.';
// categorization_decisions: a decided row is never re-opened (migration 903).
const SUGGESTION_KEPT_MESSAGE = 'Undo restores the line. If ISAFlow suggested a coding, it stays recorded as rejected.';

interface UndoContext {
  callAction: (body: Record<string, string>) => Promise<unknown>;
  /** Reloads what is on screen when the undo finishes, which may not be the view that offered it. */
  reloadCurrentView: () => void;
}

/** What `reverse` reports of the contra it posted. */
interface ContraDates { originalEntryDate?: string | null; reversalEntryDate?: string | null; vatLockRoll?: unknown }

/**
 * A customer line stays out until its unwind refuses to take on-account credit a refund already spent below zero, as
 * the supplier arm does. An account that is a bank is a transfer in all but name.
 */
export function isUndoableAllocation(sel: Pick<RowSelection, 'type' | 'entityId'>, bankAccounts: { id: string }[]): boolean {
  if (sel.type === 'supplier') return true;
  return sel.type === 'account' && !bankAccounts.some((b) => b.id === sel.entityId);
}

function notifyUndone(contra: ContraDates | undefined): void {
  const from = contra?.originalEntryDate, to = contra?.reversalEntryDate;
  if (!from || !to || from === to) { notify.success('Allocation undone'); return; }
  notify.warning(`Allocation undone. The contra is dated ${formatDisplayDate(to)}`,
    `${formatDisplayDate(from)} is in a ${contra?.vatLockRoll ? 'locked VAT' : 'closed'} period.`);
}

export function offerAllocationUndo(txId: string, journalEntryId: string, learned: boolean, ctx: UndoContext): void {
  notify.undoable('Transaction allocated', {
    ...(learned ? { message: LEARNING_KEPT_MESSAGE } : {}),
    onUndo: async () => {
      try {
        const reversed = await ctx.callAction({ action: 'reverse', bankTransactionId: txId, expectedJournalEntryId: journalEntryId }) as { data?: ContraDates };
        notifyUndone(reversed?.data);
      } catch (e) { notify.error(apiErrorMessage(e, 'Could not undo the allocation - try again')); }
      ctx.reloadCurrentView(); // a refusal means the view is out of date too
    },
  });
}

/** Only for a line the server read as `imported`: `unmatch` sets `imported` whatever the line was before. */
export function offerExcludeUndo(txId: string, ctx: UndoContext): void {
  notify.undoable('Transaction excluded', {
    message: SUGGESTION_KEPT_MESSAGE,
    onUndo: async () => {
      try {
        await ctx.callAction({ action: 'unmatch', bankTransactionId: txId, expectedStatus: 'excluded' });
        notify.success('Transaction restored');
      } catch (e) { notify.error(apiErrorMessage(e, 'Could not restore the transaction - try again')); }
      ctx.reloadCurrentView();
    },
  });
}
