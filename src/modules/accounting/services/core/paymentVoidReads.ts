/**
 * The two reads `paymentVoidService.voidPaymentDocument` makes BEFORE it takes
 * any lock: which bank lines the payment's journal settles, and the journal id
 * itself. Moved out of that file unchanged (R-127, file-size cap); the lock
 * order they serve is described in its header.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import type { PaymentKind } from './paymentVoidService';

/**
 * The bank lines this journal settles.
 *
 * Matched through `gl_journal_lines`, because `matched_journal_line_id` names a
 * LINE and the payment names an ENTRY. Only a line that is still allocated
 * counts: one already returned to `imported` has nothing left to reverse.
 *
 * Returns ALL of them, not the first, because `reverseReconciledTransaction`
 * reverses the journal once and returns exactly ONE bank line to `imported`.
 * Picking one of several would leave the others `allocated` against a journal
 * that no longer exists — invisible to unreconciled listings and unrecoverable,
 * since a later reversal of that journal throws on `reversedAt`. Ten journals
 * in production carry two bank lines each (bank transfers: one entry, two bank
 * legs), none belonging to a payment document — guessing would be the wrong way
 * to be wrong about money.
 */
export async function findBankTransactions(
  companyId: string,
  journalEntryId: string,
): Promise<string[]> {
  const rows = (await sql`
    SELECT bt.id
    FROM bank_transactions bt
    JOIN gl_journal_lines jl ON jl.id = bt.matched_journal_line_id
    WHERE bt.company_id = ${companyId}::UUID
      AND jl.journal_entry_id = ${journalEntryId}::UUID
      AND bt.status IN ('allocated', 'matched', 'reconciled')
    ORDER BY bt.transaction_date, bt.id`) as DbRow[];
  return rows.map((r) => String(r.id));
}

/** The payment's journal id WITHOUT its row lock — only to resolve the bank
 * line so THAT can be locked first (see the header). Nothing is decided from
 * it: status and number are re-read under the lock, a moved journal id is
 * caught at the call site. `undefined` = no such row for this tenant. */
export async function peekPaymentJournal(
  companyId: string, kind: PaymentKind, paymentId: string,
): Promise<string | null | undefined> {
  const rows = (kind === 'customer'
    ? await sql`SELECT gl_journal_entry_id FROM customer_payments
        WHERE id = ${paymentId}::UUID AND company_id = ${companyId}::UUID`
    : await sql`SELECT gl_journal_entry_id FROM supplier_payments
        WHERE id = ${paymentId}::UUID AND company_id = ${companyId}::UUID`) as DbRow[];
  if (rows.length === 0) return undefined;
  const id = rows[0]!.gl_journal_entry_id;
  return id == null ? null : String(id);
}
