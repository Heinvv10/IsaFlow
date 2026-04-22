/**
 * Alert Resolution Service — PRD-05 Phase 6
 * Auto-resolves pending expected_invoice_alerts when a matching supplier invoice is created.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { DbRow } from '@/lib/neon';

type Row = DbRow;

/**
 * Called after supplier_invoices INSERT succeeds.
 * If a pending alert exists for (companyId, supplierId) with expected_by within
 * ±14 days of invoiceDate, mark it resolved.
 */
export async function resolvePendingAlertForInvoice(
  companyId: string,
  supplierId: string,
  invoiceId: string,
  invoiceDate: string,
): Promise<{ resolvedAlertId: string | null }> {
  const rows = await sql`
    UPDATE expected_invoice_alerts SET
      status              = 'resolved',
      resolved_invoice_id = ${invoiceId}::uuid,
      resolved_at         = NOW(),
      updated_at          = NOW()
    WHERE company_id  = ${companyId}::uuid
      AND supplier_id = ${supplierId}::uuid
      AND status      = 'pending'
      AND expected_by BETWEEN (${invoiceDate}::date - INTERVAL '14 days')
                           AND (${invoiceDate}::date + INTERVAL '14 days')
    RETURNING id
  ` as Row[];

  const resolvedAlertId = rows.length > 0 ? String(rows[0]!.id) : null;

  if (resolvedAlertId) {
    log.info('Resolved expected_invoice_alert via new invoice', {
      companyId, supplierId, invoiceId, invoiceDate, resolvedAlertId,
    }, 'alertResolution');
  }

  return { resolvedAlertId };
}
