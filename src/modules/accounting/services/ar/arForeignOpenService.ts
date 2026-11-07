/**
 * Open customer invoices in a foreign currency, for the AR summary strip.
 *
 * getAROutstandingSummary adds total_amount - amount_paid across invoices as stored, in each invoice's own
 * currency, and does not convert. The strip therefore says how many of the open invoices are foreign, so a
 * Rand figure is never read as a converted total. Same population as the summary's `outstanding`, minus
 * deleted invoices.
 */
import { sql } from '@/lib/neon';
import { AR_OPEN_STATUSES } from '@/lib/constants/invoiceStatuses';
import { asAtTodayStr, documentInLedgerAsAtFragment } from '@/modules/accounting/services/shared/softDeleteLedgerPresence';

export async function countForeignOpenInvoices(companyId: string): Promise<number> {
  const asAtStr = asAtTodayStr();
  const rows = (await sql`
    SELECT COUNT(*) AS n
    FROM customer_invoices ci
    WHERE ci.company_id = ${companyId}
      AND ${documentInLedgerAsAtFragment('ci', asAtStr, companyId)}
      AND ci.status = ANY(${Array.from(AR_OPEN_STATUSES)}::text[])
      AND ci.deleted_at IS NULL
      AND COALESCE(ci.total_amount, 0) - COALESCE(ci.amount_paid, 0) > 0
      AND COALESCE(NULLIF(UPPER(TRIM(ci.currency_code)), ''), 'ZAR') <> 'ZAR'
  `) as { n: string }[];
  return Number(rows[0]?.n ?? 0);
}
