/**
 * Retention of invoice view receipts (POPIA, Hein 2026-11-05): `customer_invoice_views` keeps the viewer's IP address and
 * browser for 12 months, then the row goes. One global DELETE on the row's own timestamp, run daily by
 * pages/api/cron/invoice-views-retention.ts. Not tenant-scoped on purpose: the rule is the same for every company.
 */

import { sql, type DbRow } from '@/lib/neon';

export const INVOICE_VIEW_RETENTION_MONTHS = 12;

/** Deletes the receipts older than `months` (default 12) and returns how many went. */
export async function purgeInvoiceViewReceipts(months: number = INVOICE_VIEW_RETENTION_MONTHS): Promise<number> {
  if (!Number.isInteger(months) || months < 1) throw new Error('retention must be a whole number of months, at least 1');
  const rows = (await sql`
    WITH deleted AS (
      DELETE FROM customer_invoice_views WHERE viewed_at < NOW() - (${`${months} months`})::interval RETURNING id
    )
    SELECT COUNT(*)::int AS n FROM deleted
  `) as DbRow[];
  return Number(rows[0]?.n ?? 0);
}
