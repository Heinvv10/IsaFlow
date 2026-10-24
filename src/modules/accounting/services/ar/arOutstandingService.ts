/**
 * Company-wide receivables position: the ONE source for the "outstanding" and
 * "overdue" figures on the accounting dashboard and the customer invoice list
 * tiles, so the two screens cannot drift.
 *
 * Population: AR_OPEN_STATUSES, still in the ledger as at today
 * (documentInLedgerAsAtFragment). Balance is total_amount - amount_paid.
 * Overdue is a DATE fact (due_date before today, SA date) on a positive
 * balance, whatever the status string says: nothing flips 'sent'/'approved' to
 * 'overdue' when the due date passes.
 */

import { sql } from '@/lib/neon';
import { AR_OPEN_STATUSES } from '@/lib/constants/invoiceStatuses';
import { asAtTodayStr, documentInLedgerAsAtFragment } from '@/modules/accounting/services/shared/softDeleteLedgerPresence';

export interface AROutstandingSummary {
  outstanding: number;
  overdueCount: number;
  overdueAmount: number;
}

export async function getAROutstandingSummary(companyId: string): Promise<AROutstandingSummary> {
  const asAtStr = asAtTodayStr();
  const rows = (await sql`
    SELECT
      COALESCE(SUM(ci.total_amount - COALESCE(ci.amount_paid, 0)), 0) AS outstanding,
      COUNT(*) FILTER (
        WHERE ci.due_date < ${asAtStr}::date AND ci.total_amount - COALESCE(ci.amount_paid, 0) > 0
      ) AS overdue_count,
      COALESCE(SUM(ci.total_amount - COALESCE(ci.amount_paid, 0)) FILTER (
        WHERE ci.due_date < ${asAtStr}::date AND ci.total_amount - COALESCE(ci.amount_paid, 0) > 0
      ), 0) AS overdue_amount
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
