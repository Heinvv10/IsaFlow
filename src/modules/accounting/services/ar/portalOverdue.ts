/**
 * How much of a customer's statement balance is OVERDUE, for the portal chat.
 *
 * It used to be a sum of per-invoice `total_amount - amount_paid` over past-due
 * invoices. `amount_paid` only moves when money is ALLOCATED, so that sum
 * ignored an unallocated receipt and every credit note, and the assistant
 * could tell a customer they were overdue by more than they owed at all
 * (R-095 round 4: balance 629.51, "Overdue: R944.94").
 *
 * THE RULE. Start from the statement's closing balance (fetchStatementData —
 * the figure the customer is asked to pay) and treat every credit, allocated
 * or not, as settling the OLDEST-DUE debt first. What is left of the balance
 * then sits on the most recently due invoices, so:
 *
 *   overdue = clamp(closing - notYetDue, 0, closing)
 *
 * where notYetDue is the total of the statement's invoices that are not yet
 * due (due today or later, or with no due date). An unallocated receipt or a
 * credit note therefore reduces the overdue figure before it reduces anything
 * not yet due, and overdue can never exceed the closing balance, nor go below
 * zero when the customer is in credit.
 *
 * notYetDue is drawn from the SAME invoice population as the statement: the
 * shared status rule (documentPopulation), the dated soft-delete leg, and
 * invoice_date on or before the as-at date.
 */

import { sql, type DbRow } from '@/lib/neon';
import { toMoney } from '@/lib/money/decimalSum';
import { documentInLedgerAsAtFragment } from '../shared/softDeleteLedgerPresence';
import { documentInPopulationExpr } from '../shared/documentPopulation';

/** The pure half of the rule, for a balance and a not-yet-due total already in hand. */
export function overdueOfClosing(closingBalance: number, notYetDue: number): number {
  if (closingBalance <= 0) return 0;
  return toMoney(Math.min(closingBalance, Math.max(0, closingBalance - notYetDue)));
}

export async function getClientOverdue(
  clientId: string,
  companyId: string,
  asOfDate: string,
  closingBalance: number,
): Promise<number> {
  const rows = (await sql`
    SELECT COALESCE(SUM(ci.total_amount), 0) AS not_yet_due
    FROM customer_invoices ci
    WHERE COALESCE(ci.client_id, ci.customer_id) = ${clientId}::UUID
      AND ci.company_id = ${companyId}::UUID
      AND ${sql.unsafe(documentInPopulationExpr('ci'))}
      AND ${documentInLedgerAsAtFragment('ci', asOfDate, companyId)}
      AND ci.invoice_date <= ${asOfDate}::DATE
      AND (ci.due_date IS NULL OR ci.due_date >= ${asOfDate}::DATE)
  `) as DbRow[];
  return overdueOfClosing(closingBalance, Number(rows[0]?.not_yet_due ?? 0));
}
