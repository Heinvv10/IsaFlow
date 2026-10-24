/**
 * Company-wide receivables position: the ONE source for the "outstanding" and
 * "overdue" figures on the accounting dashboard, its overdue action list and
 * the customer invoice list (tiles and the Overdue status filter), so the
 * screens cannot drift.
 *
 * Population: AR_OPEN_STATUSES, still in the ledger as at today
 * (documentInLedgerAsAtFragment). Balance is total_amount - amount_paid (a
 * credit note applied to an invoice is already in amount_paid).
 * Overdue is a DATE fact (due_date before today, SA date) on a positive
 * balance, whatever the status string says: nothing flips 'sent'/'approved' to
 * 'overdue' when the due date passes. A null due_date is never overdue.
 */

import { sql } from '@/lib/neon';
import { AR_OPEN_STATUSES } from '@/lib/constants/invoiceStatuses';
import { asAtTodayStr, documentInLedgerAsAtFragment } from '@/modules/accounting/services/shared/softDeleteLedgerPresence';

export interface AROutstandingSummary {
  outstanding: number;
  overdueCount: number;
  overdueAmount: number;
}

export interface OverdueInvoiceRow {
  id: string;
  invoiceNumber: string;
  clientName: string;
  /** Open balance, not the invoice total. */
  amount: number;
  daysOverdue: number;
}

/**
 * Boolean fragment on a `customer_invoices ci` row: TRUE when the invoice is
 * overdue as at `asAtStr`. The one definition of "overdue" for AR.
 * INTERPOLATION ONLY: splice it into a sql template, never await it.
 */
export function arOverdueFragment(asAtStr: string, companyId: string) {
  return sql`(
    ci.status = ANY(${Array.from(AR_OPEN_STATUSES)}::text[])
    AND ${documentInLedgerAsAtFragment('ci', asAtStr, companyId)}
    AND ci.due_date < ${asAtStr}::date
    AND COALESCE(ci.total_amount, 0) - COALESCE(ci.amount_paid, 0) > 0
  )`;
}

export async function getAROutstandingSummary(companyId: string): Promise<AROutstandingSummary> {
  const asAtStr = asAtTodayStr();
  const overdue = arOverdueFragment(asAtStr, companyId);
  const rows = (await sql`
    SELECT
      COALESCE(SUM(COALESCE(ci.total_amount, 0) - COALESCE(ci.amount_paid, 0)), 0) AS outstanding,
      COUNT(*) FILTER (WHERE ${overdue}) AS overdue_count,
      COALESCE(SUM(COALESCE(ci.total_amount, 0) - COALESCE(ci.amount_paid, 0))
        FILTER (WHERE ${overdue}), 0) AS overdue_amount
    FROM customer_invoices ci
    WHERE ci.company_id = ${companyId}
      AND ${documentInLedgerAsAtFragment('ci', asAtStr, companyId)}
      AND ci.status = ANY(${Array.from(AR_OPEN_STATUSES)}::text[])
  `) as { outstanding: string; overdue_count: string; overdue_amount: string }[];
  const r = rows[0];
  return {
    outstanding: Number(r?.outstanding ?? 0),
    overdueCount: Number(r?.overdue_count ?? 0),
    overdueAmount: Number(r?.overdue_amount ?? 0),
  };
}

/** The `limit` oldest overdue invoices: the same population overdueCount counts. */
export async function listOverdueInvoices(companyId: string, limit: number): Promise<OverdueInvoiceRow[]> {
  const asAtStr = asAtTodayStr();
  const rows = (await sql`
    SELECT
      ci.id::text AS id,
      COALESCE(ci.invoice_number, '') AS invoice_number,
      COALESCE(c.name, '') AS client_name,
      COALESCE(ci.total_amount, 0) - COALESCE(ci.amount_paid, 0) AS amount,
      (${asAtStr}::date - ci.due_date::date) AS days_overdue
    FROM customer_invoices ci
    LEFT JOIN customers c ON c.id = COALESCE(ci.client_id, ci.customer_id) AND c.company_id = ci.company_id
    WHERE ci.company_id = ${companyId}
      AND ${arOverdueFragment(asAtStr, companyId)}
    ORDER BY ci.due_date ASC, ci.id ASC
    LIMIT ${limit}
  `) as { id: string; invoice_number: string; client_name: string; amount: string; days_overdue: number }[];
  return rows.map((r) => ({
    id: r.id,
    invoiceNumber: r.invoice_number,
    clientName: r.client_name,
    amount: Number(r.amount),
    daysOverdue: Number(r.days_overdue),
  }));
}
