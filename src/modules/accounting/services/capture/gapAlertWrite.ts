/**
 * The gap scan's one write (detectGaps, missingInvoiceChaseService): a pending expected-invoice alert for an expectation whose
 * invoice is overdue, unless an invoice arrived within 7 days of the date or the supplier already has an alert for it.
 *
 * One transaction per expectation, the supplier row first (Codex gate at ecc452ea6b, finding 2). A supplier merge holds both
 * supplier rows FOR UPDATE while it moves the expectation and the alerts (supplierMergeOpenWork.moveExpectationsAndAlerts), so the
 * scan either waits for it and then finds the supplier merged away (no alert: the next scan raises the gap on the survivor), or holds
 * the supplier until its alert is in, so a merge after it moves that alert with the rest. The expectation is re-read under that lock,
 * since the merge may have moved it. Lock order as the merge's: supplier row, then alerts, then the expectation. Outside a request
 * (the daily cron) withTransaction opens its own connection, so the locks hold until this write commits.
 */
import { withTransaction } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';

/** True when it raised the alert; false when an invoice arrived, the alert exists, or the supplier or expectation moved on. */
export async function raiseGapAlert(companyId: string, exp: DbRow, expectedBy: string): Promise<boolean> {
  const supplierId = String(exp.supplier_id);
  const expectationId = String(exp.id);
  const rows = await withTransaction(async (tx) => {
    const live = await tx`
      SELECT id FROM suppliers
       WHERE id = ${supplierId}::uuid AND company_id = ${companyId}::uuid AND deleted_at IS NULL
         FOR KEY SHARE
    ` as DbRow[];
    if (!live[0]) return [];
    const still = await tx`
      SELECT id FROM supplier_expectations
       WHERE id = ${expectationId}::uuid AND company_id = ${companyId}::uuid AND supplier_id = ${supplierId}::uuid AND status = 'locked'
         FOR SHARE
    ` as DbRow[];
    if (!still[0]) return [];

    // A matching invoice within ±7 days of the expected date: no gap.
    const [matchRow] = await tx`
      SELECT id FROM supplier_invoices
      WHERE company_id = ${companyId}::uuid
        AND supplier_id = ${supplierId}::uuid
        AND deleted_at IS NULL
        AND invoice_date BETWEEN (${expectedBy}::date - INTERVAL '7 days')
                              AND (${expectedBy}::date + INTERVAL '7 days')
      LIMIT 1
    ` as DbRow[];
    if (matchRow) return [];

    // Idempotent via UNIQUE (company_id, supplier_id, expected_by): a dismissed or resolved alert of that date also stops it.
    return await tx`
      INSERT INTO expected_invoice_alerts (
        company_id, supplier_id, expectation_id,
        expected_by, expected_amount, status
      ) VALUES (
        ${companyId}::uuid,
        ${supplierId}::uuid,
        ${expectationId}::uuid,
        ${expectedBy}::date,
        ${exp.expected_amount != null ? Number(exp.expected_amount) : null},
        'pending'
      )
      ON CONFLICT (company_id, supplier_id, expected_by) DO NOTHING
      RETURNING id
    ` as DbRow[];
  });
  return rows.length > 0;
}
