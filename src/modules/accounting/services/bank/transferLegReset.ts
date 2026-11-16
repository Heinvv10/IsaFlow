/**
 * Audit WP2 row 10 (folded into the reversed-journal follow-up, 2026-11-16): the bank Reverse of ONE line of a journal
 * another live statement line also books — the counterparty leg a transfer auto-linked — reversed the journal and reset
 * only its own line, leaving the other bank's line allocated to a journal no longer on the books. Now both legs are
 * reset in the same savepoint as the reversal.
 *
 * The other legs are the live lines that reversing the chain's head takes the cash of (`liveLinesLosingCash`), less
 * this one. They are peeked before the line lock and locked WITH it, in id order (sessions first), so two reverses of
 * the two legs cannot cross; re-read once everything is locked. A leg a reconciliation holds (completed: the shared
 * 409; open session, Sage: 400) refuses the reverse before any write — reopen or unmatch it first.
 *
 * Not for a document's chain (`reverseDocumentChainLine` frees every line of it) nor for the page's Undo, which already
 * refuses a journal with a second line (`refuseStaleUndo`).
 */
import type { DbRow } from '@/lib/neon';
import { BankAllocationRefusal } from './bankAllocationRefusal';
import type { LineChain } from './bankChainLineReversal';
import { lockBankTransactionsInIdOrder } from './bankTxLock';
import { liveLinesLosingCash } from './liveBankLineReversal';
import { reconciliationLockOf, refuseLockedCash } from './reconciledCash';
import { peekReversalTarget } from './reversalDatePostable';

const OTHER_LEG = "The other bank's line of this transfer";

async function otherLegs(companyId: string, bankTxId: string, chain: LineChain | null): Promise<string[]> {
  if (!chain || chain.doc) return [];
  const head = await peekReversalTarget(companyId, chain.rootId);
  if (!head) return [];
  return (await liveLinesLosingCash(companyId, head)).filter((id) => id.toLowerCase() !== bankTxId.toLowerCase());
}

/** Before the line lock: the other legs, locked together with this line in id order. The locked rows, by id. */
export async function lockOtherLegs(
  companyId: string, bankTxId: string, chain: LineChain | null, undoing: boolean,
): Promise<Map<string, DbRow>> {
  const legs = undoing ? [] : await otherLegs(companyId, bankTxId, chain);
  if (legs.length === 0) return new Map();
  const rows = await lockBankTransactionsInIdOrder(companyId, [bankTxId, ...legs]);
  return new Map(rows.filter((r) => String(r.id).toLowerCase() !== bankTxId.toLowerCase())
    .map((r) => [String(r.id).toLowerCase(), r]));
}

/**
 * Pre-write, once this line and the journal's chain are read under the locks: the legs (locked rows) to reset with this
 * one. A leg that appeared since the peek (not locked) is a retryable refusal; one a reconciliation holds refuses the
 * reverse. The caller judges each leg as it judges its own line (assertMayReverse), and audits and records its undo.
 */
export async function takeOtherLegs(
  companyId: string, bankTxId: string, chain: LineChain | null, locked: ReadonlyMap<string, DbRow>, undoing: boolean,
): Promise<DbRow[]> {
  if (undoing) return [];
  const legs: DbRow[] = [];
  for (const id of await otherLegs(companyId, bankTxId, chain)) {
    const row = locked.get(id.toLowerCase());
    if (!row) {
      throw new BankAllocationRefusal('Another bank line was matched to this journal while it was being reversed — '
        + 'retry in a moment.', undefined, { retryable: true });
    }
    refuseLockedCash(await reconciliationLockOf(companyId, row), OTHER_LEG);
    legs.push(row);
  }
  return legs;
}
