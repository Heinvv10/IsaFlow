/**
 * The in-app customer statements (`customer-statement`, `customer-statement-detail`)
 * state the same balance as the emailed statement (`statementEmailService`),
 * which is the reference document (R-095, R-112, R-113). The email applies these
 * rules in JS row by row; the screens aggregate in SQL, so the rules live here
 * as SQL twins. Keep the two in step.
 *
 *   - A receipt is credited at what the customer PAID (`total_amount`), never
 *     at what has been allocated: a partly allocated receipt's remainder is
 *     still money received. Only 'confirmed' and 'reconciled' receipts settle.
 *   - A credit note is live at 'approved', 'partially_applied' or 'applied',
 *     and is valued by `shared/creditNoteAppliedAmount` — an 'applied' note at
 *     what it consumed, anything else at face value.
 */
import { sql } from '@/lib/neon';
import { documentInLedgerAsAtFragment } from '../shared/softDeleteLedgerPresence';
import { documentInPopulationExpr } from '../shared/documentPopulation';

export const SETTLING_RECEIPT_STATUSES = ['confirmed', 'reconciled'];
export const LIVE_CREDIT_NOTE_STATUSES = ['approved', 'partially_applied', 'applied'];

/** SQL twin of `creditNoteAppliedAmount`, for a `credit_notes` row with no alias. */
export const CREDIT_NOTE_STATEMENT_VALUE =
  "(CASE WHEN status = 'applied' THEN applied_amount ELSE total_amount END)";

/**
 * What the customer owed at the start of `fromDate`: every document dated
 * before it, by the rules above. A windowed statement that drops this starts
 * its running balance at zero and misstates what is owed whenever there is
 * older activity (R-113: a true 600 shown as -400).
 *
 * The soft-delete question is asked at `ledgerAsAt` (the statement's upper
 * bound), the same date the window's own invoices are asked at, so a document
 * cannot be counted in one part of the statement and dropped from the other.
 */
export async function customerBalanceBroughtForward(
  companyId: string,
  customerId: string,
  fromDate: string,
  ledgerAsAt: string,
): Promise<number> {
  const [row] = (await sql`
    SELECT
      COALESCE((
        SELECT SUM(ci.total_amount::numeric) FROM customer_invoices ci
        WHERE COALESCE(ci.client_id, ci.customer_id) = ${customerId}::UUID
          AND ci.company_id = ${companyId}::UUID
          AND ${sql.unsafe(documentInPopulationExpr('ci'))}
          AND ${documentInLedgerAsAtFragment('ci', ledgerAsAt, companyId)}
          AND ci.invoice_date < ${fromDate}::DATE
      ), 0)
      - COALESCE((
        SELECT SUM(cp.total_amount::numeric) FROM customer_payments cp
        WHERE cp.client_id = ${customerId}::UUID AND cp.company_id = ${companyId}::UUID
          AND cp.status = ANY(${SETTLING_RECEIPT_STATUSES})
          AND cp.payment_date < ${fromDate}::DATE
      ), 0)
      - COALESCE((
        SELECT SUM(${sql.unsafe(CREDIT_NOTE_STATEMENT_VALUE)}::numeric) FROM credit_notes
        WHERE client_id = ${customerId}::UUID AND company_id = ${companyId}::UUID
          AND type = 'customer' AND status = ANY(${LIVE_CREDIT_NOTE_STATUSES})
          AND credit_date < ${fromDate}::DATE
      ), 0) AS balance
  `) as { balance: unknown }[];
  return Number(row?.balance ?? 0);
}
