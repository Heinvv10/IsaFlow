/**
 * R-127 (review MEDIUM, LOW 4): once a bank-first provisional has become a bill's
 * payment, two journals hold that settlement up — the provisional (its bank
 * credit) and the reclass (the settlement payment's `gl_journal_entry_id`).
 * Reversing either alone breaks it: without the provisional the reclass debits
 * AP with no cash behind it; without the reclass the bill's expense and VAT
 * stand twice (why voiding the payment is refused, `supplierPaymentGates.ts`).
 *
 * Both refusals are `SupplierPaymentRefusal` (routes answer 400, MCP surfaces
 * the message, the auto-post undo counts the line as failed and keeps the run
 * open), raised before any write — `refuseReversingSettlementJournal` right
 * after `reverseJournalEntry`'s reversal claim (D8 round 4), which it releases.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { SupplierPaymentRefusal } from './supplierPaymentRefusal';
import { MAX_CHAIN_DEPTH } from '../shared/journalChainHead';

/** How every settlement refusal names the undo — the UI action first. */
export const UNAPPLY_REMEDY = 'Unapply on the payment page (or the unapply_supplier_payment tool)';

/** Only these sources can be either half; anything else is decided without a query. */
const SETTLEMENT_SOURCES = new Set(['auto_bank_recon', 'auto_supplier_payment']);

/** Called by `reverseJournalEntry` for every entry it reverses, once its claim holds the row. */
export async function refuseReversingSettlementJournal(
  companyId: string,
  entry: { id: string; entryNumber: string; source?: string | null },
): Promise<void> {
  if (!entry.source || !SETTLEMENT_SOURCES.has(entry.source)) return;
  // The entry OR any entry it reverses (D8): a provisional reversed and
  // re-reversed settles through its chain, and reversing the head R2 takes it
  // out of the ledger exactly as reversing it would. Walked up `reversal_of_id`
  // with the same guard as shared/journalChainHead: the path, so a forged loop
  // stops at its first repeat, and MAX_CHAIN_DEPTH.
  const [row] = (await sql`
    WITH RECURSIVE up AS (
      SELECT id, reversal_of_id, ARRAY[id] AS path FROM gl_journal_entries
      WHERE id = ${entry.id}::UUID AND company_id = ${companyId}::UUID
      UNION ALL
      SELECT p.id, p.reversal_of_id, up.path || p.id FROM gl_journal_entries p
      JOIN up ON p.id = up.reversal_of_id
      WHERE p.company_id = ${companyId}::UUID
        AND NOT p.id = ANY(up.path) AND cardinality(up.path) < ${MAX_CHAIN_DEPTH}
    )
    SELECT payment_number, settles_provisional_je_id IN (SELECT id FROM up) AS is_provisional
    FROM supplier_payments
    WHERE company_id = ${companyId}::UUID AND status <> 'cancelled'
      AND settles_provisional_je_id IS NOT NULL
      AND (settles_provisional_je_id IN (SELECT id FROM up) OR gl_journal_entry_id IN (SELECT id FROM up))
    LIMIT 1
  `) as DbRow[];
  if (!row) return;
  const half = row.is_provisional === true
    ? 'is the bank-first provisional that settled'
    : 'is the reclass that made its provisional the settlement of';
  throw new SupplierPaymentRefusal(
    `Journal entry ${entry.entryNumber} ${half} a supplier bill through payment ${String(row.payment_number)}. `
    + `Reversing it alone would leave that settlement half-booked. To undo it, use ${UNAPPLY_REMEDY}, then `
    + 'void the payment: that reverses the provisional and its reclass together and frees the bank line.',
  );
}

/**
 * Called by `reverseReconciledTransaction` for the bank line it is about to reset.
 * A provisional's own line has no matched journal line, so that reversal reverses
 * nothing and sets the line back to 'imported' — cash the provisional still books,
 * made re-allocatable. Refused while a live settlement holds the provisional.
 */
export async function refuseSettledProvisionalLine(
  companyId: string,
  tx: { provisional_je_id?: unknown; matched_journal_line_id?: unknown },
): Promise<void> {
  if (!tx.provisional_je_id || tx.matched_journal_line_id) return;
  const [row] = (await sql`
    SELECT payment_number FROM supplier_payments
    WHERE company_id = ${companyId}::UUID AND status <> 'cancelled'
      AND settles_provisional_je_id = ${String(tx.provisional_je_id)}::UUID
    LIMIT 1
  `) as DbRow[];
  if (!row) return;
  throw new SupplierPaymentRefusal(
    `This bank line's provisional journal settled a supplier bill through payment ${String(row.payment_number)}. `
    + `Resetting the line would leave that cash booked and allocatable again. To undo it, use ${UNAPPLY_REMEDY}, `
    + 'then void the payment: that reverses both journals and frees this line.',
  );
}
