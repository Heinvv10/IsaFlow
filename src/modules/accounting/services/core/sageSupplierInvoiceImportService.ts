/**
 * PRD-060 Phase 6: Sage Data Importers — supplier invoices
 * Sage supplier invoices → AP supplier_invoices
 *
 * Split out of sageImportService.ts, which was over the 300-line cap and grew
 * further with the savepoint fix. The two importers share no code: this one
 * touches sage_supplier_invoices and supplier_invoices, the ledger one touches
 * sage_ledger_transactions and the GL.
 *
 * BL-40: Every SELECT/JOIN/INSERT/UPDATE is scoped by company_id to prevent
 * cross-tenant data leaks and silent INSERT failures caused by missing NOT NULL
 * company_id columns.
 */

import { sql, withSavepoint } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { MigrationRun } from './sageMigrationService';
import { startRun, completeRun, withRunRecovery } from './sageMigrationService';
import type { DbRow } from '@/types/db';
import { computeFingerprint } from '../capture/captureDeduplicationService';
import { deriveSageVat, SAGE_VAT_NOT_STATED_NOTE } from '../shared/sageVatDerivation';

// ── Supplier Invoice Import ─────────────────────────────────────────────────

type RowOutcome = 'imported' | 'already_in_ap' | 'no_supplier';

/**
 * Import sage_supplier_invoices into the supplier_invoices table.
 * Matches Sage's approach: invoices are standalone AP documents,
 * no separate GL journal entries are created per invoice.
 *
 * R-021: the staging table holds only what the Sage invoice list returns —
 * (sage_id, invoice_number, supplier_name, invoice_date, total_amount). It has
 * no supplier id, due date, tax split, payment state or line items; an earlier
 * revision SELECTed eleven such columns, so the first statement raised 42703
 * for every tenant and no bill ever came through this path. The row mapping
 * reads what the table has and derives the rest:
 *   - supplier: the ONE supplier of that name (case-insensitive) on the
 *     company. None, or more than one, fails the row — supplier_id drives every
 *     AP balance, and a bill on the wrong supplier never reconciles.
 *   - due date: invoice date plus the supplier's payment_terms days.
 *   - VAT: none stated, so none recorded and the bill flagged (R-089,
 *     `deriveSageVat`). Never a 15% unwind of the total.
 *   - payment state: unpaid. Staging carries no payment, and a bill called
 *     paid with no payment behind it drops out of AP aging with nothing in the
 *     bank to match.
 *
 * K-088: a re-run after `resetMigration` must not book the bill twice. A bill
 * already in AP for the same supplier with the same duplicate fingerprint
 * (VAT number | invoice number | total — the key every other AP entry path
 * checks) is linked, not re-inserted, and counted as skipped.
 */
export async function importSupplierInvoices(companyId: string, userId: string): Promise<MigrationRun> {
  const runId = await startRun('invoice_import', userId, companyId);

  return withRunRecovery(runId, async () => {
    // BL-40: Added AND company_id to prevent cross-tenant SELECT
    const sageInvoices = (await sql`
      SELECT id, sage_id, invoice_number, supplier_name, invoice_date, total_amount
      FROM sage_supplier_invoices
      WHERE migration_status = 'pending'
        AND company_id = ${companyId}::UUID
      ORDER BY invoice_date, id
    `) as DbRow[];

    let succeeded = 0;
    let failed = 0;
    let skipped = 0;
    let vatNotStated = 0;

    for (const inv of sageInvoices) {
      try {
        const totalAmount = Number(inv.total_amount || 0);
        if (totalAmount === 0) { skipped++; continue; }

        // Every statement for this record runs inside its own savepoint, so a
        // failing row rolls back alone and the 'failed' marker below lands on
        // a usable transaction (K-090, the per-row half).
        const outcome = await withSavepoint('sage_supplier_invoice_record', async (): Promise<RowOutcome> => {
          const supplierName = String(inv.supplier_name ?? '').trim();
          const suppliers = (await sql`
            SELECT id, vat_number, payment_terms
            FROM suppliers
            WHERE company_id = ${companyId}::UUID
              AND deleted_at IS NULL
              AND lower(name) = lower(${supplierName})
            LIMIT 2
          `) as DbRow[];
          if (suppliers.length !== 1) {
            log.warn('Sage supplier invoice does not name exactly one supplier on this company', {
              companyId, stagingId: inv.id, supplierName, matches: suppliers.length,
            }, 'accounting');
            return 'no_supplier';
          }
          const supplier = suppliers[0]!;
          const supplierId = String(supplier.id);

          const sageId = inv.sage_id ? String(inv.sage_id) : null;
          const invNumber = inv.invoice_number
            ? String(inv.invoice_number)
            : `SAGE-${sageId ?? String(inv.id)}`;
          const dupFingerprint = computeFingerprint(
            supplier.vat_number ? String(supplier.vat_number) : null,
            invNumber,
            totalAmount,
          );

          const [existing] = (await sql`
            SELECT id FROM supplier_invoices
            WHERE company_id = ${companyId}::UUID
              AND supplier_id = ${supplierId}::UUID
              AND duplicate_fingerprint = ${dupFingerprint}
              AND deleted_at IS NULL
            ORDER BY created_at, id
            LIMIT 1
          `) as DbRow[];

          let billId: string;
          let rowVatNotStated = false;
          if (existing) {
            billId = String(existing.id);
          } else {
            // Staging has no subtotal and no tax column, so no VAT is stated.
            const vat = deriveSageVat(null, null, totalAmount);
            rowVatNotStated = vat.vatNotStated;
            const paymentTerms = Number(supplier.payment_terms ?? 30) || 0;

            // BL-40: Added company_id to INSERT — was missing, causing NOT NULL violation
            const newInv = (await sql`
              INSERT INTO supplier_invoices (
                company_id, invoice_number, supplier_id, invoice_date, due_date,
                subtotal, tax_rate, tax_amount, total_amount,
                amount_paid, status, sage_invoice_id, notes, created_by,
                duplicate_fingerprint
              ) VALUES (
                ${companyId}::UUID, ${invNumber}, ${supplierId}::UUID,
                ${inv.invoice_date}, ${inv.invoice_date}::DATE + ${paymentTerms}::INT,
                ${vat.subtotal.toFixed(2)}, ${vat.taxRate}, ${vat.taxAmount.toFixed(2)}, ${totalAmount},
                0, 'approved', ${sageId},
                ${rowVatNotStated ? SAGE_VAT_NOT_STATED_NOTE : null}, ${userId},
                ${dupFingerprint}
              ) RETURNING id
            `) as DbRow[];
            billId = String(newInv[0]!.id);
          }

          // BL-40: UPDATE scoped by company_id
          await sql`
            UPDATE sage_supplier_invoices
            SET migration_status = 'imported', gl_supplier_invoice_id = ${billId}::UUID
            WHERE id = ${inv.id}
              AND company_id = ${companyId}::UUID
          `;

          // Counted only once the row has landed: a row whose savepoint rolls
          // back must not inflate the review count (review-r089-r1.md LOW-3).
          if (rowVatNotStated) vatNotStated++;
          return existing ? 'already_in_ap' : 'imported';
        });

        if (outcome === 'imported') {
          succeeded++;
        } else if (outcome === 'already_in_ap') {
          skipped++;
        } else {
          // Outside the savepoint, so the marker survives.
          await markFailed(companyId, inv.id);
          failed++;
        }
      } catch (err) {
        // The savepoint has rolled back, so the transaction is usable and this
        // statement will land.
        log.error('Failed to import sage invoice', { invoiceId: inv.id, error: err }, 'accounting');
        await markFailed(companyId, inv.id);
        failed++;
      }
    }

    return await completeRun(runId, sageInvoices.length, succeeded, failed, skipped, vatNotStated);
  });
}

/** Mark one staging row failed, scoped by company_id (BL-40). */
async function markFailed(companyId: string, stagingId: unknown): Promise<void> {
  await sql`
    UPDATE sage_supplier_invoices
    SET migration_status = 'failed'
    WHERE id = ${stagingId}
      AND company_id = ${companyId}::UUID
  `;
}
