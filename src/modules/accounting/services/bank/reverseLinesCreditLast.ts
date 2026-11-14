/**
 * Reversing several bank lines in one call (MCP `reverse_bank_allocation_batch` / `_range`) when the call cancels a
 * contact's payments together with refunds of the same cash.
 *
 * SUPPLIERS (Hein's ruling 2026-10-26, `ap/supplierVoidCredit`): lines are reversed in id order (the shared lock
 * order). A payment's line that sorts before its refund's is refused by the void credit check only because the refund
 * still stands; reversing both leaves the credit where it was. So a line refused for credit is set aside and tried
 * once more after every other line, as `undoRun` does (`autoPostUndoAttempt`). One retry is enough: a refund's
 * reversal raises the credit and is never refused, so every refund in the call is reversed by then, and the payments
 * left each lower it — they all pass exactly when the call's net leaves the supplier at zero or above
 * (`assertLinesKeepCredit`, the dry run's answer). Refused again, the refusal is thrown and the call stays
 * all-or-nothing. A set-aside line may have written before its refusal — on a split line a customer arm is unwound
 * (its receipt cancelled, its customer's credit lock taken) before the supplier arm is refused — but none of it
 * survives: `reverseReconciledTransaction` runs every write inside its own savepoint (`bank_reverse_reconciled`, or
 * `bank_reverse_chain_line` for a document chain), so the refusal rolls it all back and RELEASES the row locks taken
 * inside the savepoint (the customer's included). The bank line is locked before that savepoint and stays held; the
 * retry re-takes the rest.
 *
 * CUSTOMERS (`ar/customerVoidCredit`): no retry. The receipts and refunds on the call's lines are judged TOGETHER,
 * ONCE, up front (`judgeReceiptCancellations`, by date) — the dry run and the live call run that one function, so they
 * agree by construction (a per-receipt judgment with a retry can refuse a set the set judgment passes, when the
 * customer is already below zero on a later date). The live call then reverses inside `withReceiptCancellationsJudged`:
 * each receipt's own check only verifies, under its locks and its customer's, that nothing the judgment read has moved
 * since, at every receipt under the customer lock taken again (a set-aside line's rolled-back savepoint releases the
 * lock it took, so nothing is carried between receipts).
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { assertVoidKeepsCredit, isVoidCreditRefusal } from '../ap/supplierVoidCredit';
import { judgeReceiptCancellations, withReceiptCancellationsJudged } from '../ar/customerVoidCredit';
import { findJournalChainRoot } from '../shared/journalChainHead';

/** Runs `reverse` over `ids` in the order given, retrying supplier-credit-refused ones once after the rest. */
export async function reverseLinesCreditLast(ids: readonly string[], reverse: (id: string) => Promise<unknown>): Promise<void> {
  const setAside: string[] = [];
  for (const id of ids) {
    try {
      await reverse(id);
    } catch (err) {
      if (!isVoidCreditRefusal(err)) throw err;
      setAside.push(id);
    }
  }
  for (const id of setAside) await reverse(id);
}

/** The chain ROOT of each line's matched journal, as `peekLineChain` finds it (a loop has none: skipped). */
async function rootsOf(companyId: string, journalIds: readonly (string | null)[]): Promise<string[]> {
  const roots: string[] = [];
  for (const je of new Set(journalIds.filter((j): j is string => j !== null))) {
    const root = await findJournalChainRoot(companyId, je);
    if (root) roots.push(root);
  }
  return roots;
}

/** The customer receipts and refunds the reversals of these lines would cancel (those on their chain roots). */
async function receiptsOnRoots(companyId: string, roots: readonly string[]): Promise<string[]> {
  if (roots.length === 0) return [];
  const rows = (await sql`
    SELECT cp.id FROM customer_payments cp
    WHERE cp.company_id = ${companyId}::UUID AND cp.gl_journal_entry_id = ANY(${[...roots]}::UUID[])
  `) as DbRow[];
  return rows.map((r) => String(r.id));
}

/**
 * The dry run's answer, decided up front: the supplier payments and refunds these lines' reversals would void, voided
 * together (refunds raise the credit, payments lower it), must leave each supplier at zero or above; the customer
 * receipts and refunds, cancelled together, must leave each customer's running credit at zero or above on every date
 * they lower. Found as the live reversal finds them: from each line's matched journal to its chain ROOT
 * (`findJournalChainRoot`, as `peekLineChain` does), then the payments on that root and the members of a processed
 * payment batch posted on it. A chain with no root (a loop) is skipped here: the live call refuses it anyway.
 */
export async function assertLinesKeepCredit(companyId: string, journalIds: readonly (string | null)[]): Promise<void> {
  const roots = await rootsOf(companyId, journalIds);
  if (roots.length === 0) return;
  const rows = (await sql`
    SELECT sp.id FROM supplier_payments sp
    WHERE sp.company_id = ${companyId}::UUID
      AND (sp.gl_journal_entry_id = ANY(${roots}::UUID[])
        OR sp.batch_id IN (SELECT b.id FROM supplier_payment_batches b
                           WHERE b.company_id = ${companyId}::UUID AND b.status = 'processed'
                             AND b.gl_journal_entry_id = ANY(${roots}::UUID[])))
  `) as DbRow[];
  await assertVoidKeepsCredit(companyId, rows.map((r) => String(r.id)));
  await judgeReceiptCancellations(companyId, await receiptsOnRoots(companyId, roots));
}

/**
 * The live bulk reversal: the customer side judged once up front (the dry run's judgment), then every line reversed
 * in the order given with the supplier retry (`reverseLinesCreditLast`).
 */
export async function reverseLinesJudged(
  companyId: string,
  lines: readonly { id: string; journalEntryId: string | null }[],
  reverse: (id: string) => Promise<unknown>,
): Promise<void> {
  const receipts = await receiptsOnRoots(companyId, await rootsOf(companyId, lines.map((l) => l.journalEntryId)));
  await withReceiptCancellationsJudged(companyId, receipts,
    () => reverseLinesCreditLast(lines.map((l) => l.id), reverse));
}
