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
import { fmtDate } from '@/lib/fmtDate';
import { isRealCalendarDate } from '@/lib/validation';
import { RunningBalance, toMoney } from '@/lib/money/decimalSum';
import { asAtTodayStr, documentInLedgerAsAtFragment } from '../shared/softDeleteLedgerPresence';
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
  return toMoney(Number(row?.balance ?? 0));
}

/** One line of an in-app customer statement. */
export interface StatementLine {
  id: string;
  date: string;
  type: 'invoice' | 'payment' | 'credit_note' | 'opening_balance';
  reference: string;
  description: string;
  debit: number;
  credit: number;
  balance: number;
}

/**
 * The statement window. Both bounds are LOCAL calendar dates (SAST), as the
 * emailed statement's as-at date is: `toISOString()` is UTC, so between 00:00
 * and 02:00 it named yesterday and dropped today's documents. A bound that is
 * not a real date, or a window that ends before it starts, is refused rather
 * than cast by Postgres (a 500) or silently emptied.
 */
export function resolveStatementWindow(
  fromDate: unknown,
  toDate: unknown,
): { from: string; to: string } | { error: string } {
  const to = toDate === undefined || toDate === '' ? asAtTodayStr() : toDate;
  if (typeof to !== 'string' || !isRealCalendarDate(to)) return { error: 'toDate must be a YYYY-MM-DD date' };
  let from = fromDate;
  if (from === undefined || from === '') {
    // A year before the window's END, so an old toDate alone still has a window.
    const [y, m, d] = to.split('-').map(Number) as [number, number, number];
    const yearBefore = new Date(y, m - 1, d);
    yearBefore.setDate(yearBefore.getDate() - 365);
    from = fmtDate(yearBefore);
  }
  if (typeof from !== 'string' || !isRealCalendarDate(from)) return { error: 'fromDate must be a YYYY-MM-DD date' };
  if (from > to) return { error: 'fromDate must not be after toDate' };
  return { from, to };
}

/**
 * The as-at date of a balances list or a full-history statement (R-116). No
 * date means TODAY, a LOCAL calendar date as `resolveStatementWindow` uses; a
 * value that is not a real date is refused rather than cast by Postgres (a 500)
 * or quietly replaced by today, which printed today's figures under the date
 * the user picked.
 */
export function resolveStatementAsAt(asAt: unknown): { asAt: string } | { error: string } {
  if (asAt === undefined || asAt === '') return { asAt: asAtTodayStr() };
  if (typeof asAt !== 'string' || !isRealCalendarDate(asAt)) return { error: 'as_at_date must be a YYYY-MM-DD date' };
  return { asAt };
}

/**
 * The brought-forward line, dated at the window's first day. It carries the
 * opening figure in the debit or credit column (a debt or a credit balance),
 * so the columns foot to the closing balance like every other line; none when
 * nothing is brought forward.
 */
export function openingBalanceLine(openingBalance: number, from: string): StatementLine | null {
  if (openingBalance === 0) return null;
  return {
    id: 'opening-balance', date: from, type: 'opening_balance', reference: '',
    description: 'Balance brought forward',
    debit: openingBalance > 0 ? openingBalance : 0,
    credit: openingBalance < 0 ? -openingBalance : 0,
    balance: 0,
  };
}

/** Fills each line's running balance in decimal arithmetic, as the email does. */
export function applyRunningBalance(lines: { debit: number; credit: number; balance: number }[]): void {
  const running = new RunningBalance();
  for (const line of lines) {
    running.add(line.debit);
    line.balance = running.subtract(line.credit);
  }
}

/** Opening + invoiced - paid - credits, rounded to cents. */
export function statementClosingBalance(
  openingBalance: number, invoiced: number, paid: number, credits: number,
): number {
  const running = new RunningBalance(openingBalance);
  running.add(invoiced);
  running.subtract(paid);
  return running.subtract(credits);
}
