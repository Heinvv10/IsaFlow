/**
 * Whether a posted journal is actually IN the books.
 *
 * `createJournalEntry` leaves `fiscal_period_id` NULL when no fiscal period
 * covers the entry date, and `postJournalEntry` does not object. Such an entry
 * exists in `gl_journal_entries` and appears in NO period-scoped report — not
 * the trial balance, not the VAT201, not the AFS.
 *
 * That was survivable while a bank allocation only posted a journal: the
 * subledger did not move, so the two agreed about nothing rather than
 * disagreeing. It stops being survivable once the same journal settles bills.
 * A bill marked `paid` off an invisible journal reads as settled everywhere
 * while the cash that settled it is in none of the statements — an AP control
 * versus subledger gap with no journal behind it to find.
 *
 * So the DOCUMENT is still created for that cash (it left the bank either way,
 * and a document is how anyone finds it again), and only the APPLICATION is
 * withheld. The payment then sits unapplied, where `list_unapplied_payments`
 * and `list_unapplied_receipts` report it and a human can settle it once the
 * fiscal year exists.
 *
 * The sibling paths refuse earlier and better: `validateBankSupplierPayment`
 * and `confirmReceiptMatch` both run `getPeriodStatusForDate` BEFORE posting
 * anything. This is the late guard for the path that has already posted.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';

/**
 * True when the entry carries a fiscal period. False when it does not, or when
 * no such entry belongs to this company — the caller withholds settlement
 * either way, which is the safe reading of both.
 */
export async function journalIsInAPeriod(
  companyId: string,
  journalEntryId: string,
): Promise<boolean> {
  const rows = (await sql`
    SELECT fiscal_period_id FROM gl_journal_entries
    WHERE id = ${journalEntryId}::UUID AND company_id = ${companyId}::UUID
  `) as DbRow[];
  return rows.length > 0 && rows[0]!.fiscal_period_id !== null;
}
