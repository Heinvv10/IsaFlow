/**
 * Reversing several bank lines in one call (MCP `reverse_bank_allocation_batch` / `_range`) when one may be a
 * supplier payment whose cash a refund in the same call returned (Hein's ruling 2026-10-26, `ap/supplierVoidCredit`).
 *
 * Lines are reversed in id order (the shared lock order). A payment's line that sorts before its refund's is refused
 * by the void credit check only because the refund still stands; reversing both leaves the credit where it was. So a
 * line refused for credit is set aside and tried once more after every other line, as `undoRun` does
 * (`autoPostUndoAttempt`). One retry is enough: a refund's reversal raises the credit and is never refused, so every
 * refund in the call is reversed by then, and the payments left each lower it — they all pass exactly when the
 * call's net leaves the supplier at zero or above (`assertLinesKeepCredit`, the dry run's answer). Refused again, the
 * refusal is thrown and the call stays all-or-nothing. `reverseReconciledTransaction` writes inside its own savepoint
 * and refuses before its first write, so a set-aside line has written nothing; its bank line stays locked by this
 * transaction, and the retry re-takes locks this transaction already holds.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { assertVoidKeepsCredit, isVoidCreditRefusal } from '../ap/supplierVoidCredit';

/** Runs `reverse` over `ids` in the order given, retrying credit-refused ones once after the rest. */
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

/**
 * The same refusal, decided up front for a preview: the supplier payments and refunds these journals carry, voided
 * together (refunds raise the credit, payments lower it), must leave each supplier at zero or above.
 */
export async function assertLinesKeepCredit(companyId: string, journalIds: readonly (string | null)[]): Promise<void> {
  const ids = journalIds.filter((j): j is string => j !== null);
  if (ids.length === 0) return;
  const rows = (await sql`
    SELECT id FROM supplier_payments
    WHERE company_id = ${companyId}::UUID AND gl_journal_entry_id = ANY(${ids}::UUID[])
  `) as DbRow[];
  await assertVoidKeepsCredit(companyId, rows.map((r) => String(r.id)));
}
