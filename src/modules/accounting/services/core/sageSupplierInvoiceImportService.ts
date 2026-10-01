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
import { lockMigrationImport } from './migrationPostingSupport';
import type { DbRow } from '@/types/db';
import { computeFingerprint } from '../capture/captureDeduplicationService';
import { deriveSageVat, SAGE_VAT_NOT_STATED_NOTE } from '../shared/sageVatDerivation';
import { assertMayImportOpenBills, withApprovalGateExempt } from '../gl/approvalGateExempt';

// ── Supplier Invoice Import ─────────────────────────────────────────────────

type RowOutcome = 'imported' | 'already_in_ap' | 'failed';

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
 *   - supplier: the ONE live supplier of that name (case- and whitespace-
 *     insensitive) on the company. None, or more than one, fails the row —
 *     supplier_id drives every AP balance, and a bill on the wrong supplier
 *     never reconciles.
 *   - due date: invoice date plus the supplier's payment_terms days. A
 *     supplier with no terms gets NO due date rather than an invented one;
 *     the ageing lists such a bill under "no due date", still owed.
 *   - VAT: none stated, so none recorded and the bill flagged (R-089,
 *     `deriveSageVat`). Never a 15% unwind of the total.
 *   - payment state: unpaid. Staging carries no payment.
 *   - a negative or zero total fails the row: a credit note is not an
 *     approved bill with a negative balance, and a zero bill is nothing.
 *
 * K-088: a re-run after `resetMigration` must not book the bill twice. The
 * staged row is matched to a live bill by (supplier, sage_invoice_id) first —
 * the identity Sage gave it — and only then by the table's own unique key
 * (supplier, invoice_number); either way the totals must agree. A live bill
 * under that number with a different Sage id or a different total is a
 * distinct document; the row fails rather than being merged into it (see
 * `findExistingBill`). The whole run holds the company's migration import
 * lock, so two concurrent runs cannot race the same pending rows.
 */
export async function importSupplierInvoices(companyId: string, userId: string): Promise<MigrationRun> {
  // R-035 HIGH-2: every staged bill is open (amount_paid 0) — refuse before the run is recorded.
  await assertMayImportOpenBills(companyId, userId);
  const runId = await startRun('invoice_import', userId, companyId);

  return withRunRecovery(runId, companyId, async () => {
    await lockMigrationImport(companyId);
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
      let outcome: RowOutcome;
      try {
        // Every statement for this record runs inside its own savepoint, so a
        // failing row rolls back alone and the 'failed' marker below lands on
        // a usable transaction (K-090, the per-row half).
        outcome = await withSavepoint('sage_supplier_invoice_record', async (): Promise<RowOutcome> => {
          const totalAmount = Number(inv.total_amount || 0);
          if (!(totalAmount > 0)) {
            log.warn('Sage supplier invoice has no positive total; not booked as a bill', {
              companyId, stagingId: inv.id, totalAmount,
            }, 'accounting');
            return 'failed';
          }

          const supplierName = String(inv.supplier_name ?? '').trim();
          const suppliers = (await sql`
            SELECT id, vat_number, payment_terms
            FROM suppliers
            WHERE company_id = ${companyId}::UUID
              AND deleted_at IS NULL
              AND lower(btrim(name)) = lower(${supplierName})
            LIMIT 2
          `) as DbRow[];
          if (suppliers.length !== 1) {
            log.warn('Sage supplier invoice does not name exactly one supplier on this company', {
              companyId, stagingId: inv.id, supplierName, matches: suppliers.length,
            }, 'accounting');
            return 'failed';
          }
          const supplier = suppliers[0]!;
          const supplierId = String(supplier.id);
          const sageId = inv.sage_id ? String(inv.sage_id) : null;
          const invNumber = inv.invoice_number ? String(inv.invoice_number) : `SAGE-${sageId ?? String(inv.id)}`;

          const existing = await findExistingBill(companyId, supplierId, sageId, invNumber, totalAmount);
          if (existing === 'conflict') {
            log.warn('A live bill under this number is a different document (other Sage id or total)', {
              companyId, stagingId: inv.id, supplierId, invNumber, sageId, totalAmount,
            }, 'accounting');
            return 'failed';
          }

          let billId: string;
          let rowVatNotStated = false;
          if (existing) {
            billId = existing;
          } else {
            // Staging has no subtotal and no tax column, so no VAT is stated.
            const vat = deriveSageVat(null, null, totalAmount);
            rowVatNotStated = vat.vatNotStated;
            const paymentTerms = supplier.payment_terms == null ? null : Number(supplier.payment_terms);
            const dupFingerprint = computeFingerprint(
              supplier.vat_number ? String(supplier.vat_number) : null, invNumber, totalAmount,
            );

            // BL-40: Added company_id to INSERT — was missing, causing NOT NULL violation
            // R-035 Q1: approved in Sage, so exempt from the approval backstop.
            const newInv = (await withApprovalGateExempt({ companyId, userId, open: true }, () => sql`
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
            `)) as DbRow[];
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
      } catch (err) {
        // The savepoint has rolled back, so the transaction is usable and the
        // marker below will land.
        log.error('Failed to import sage invoice', { invoiceId: inv.id, error: err }, 'accounting');
        outcome = 'failed';
      }

      if (outcome === 'imported') succeeded++;
      else if (outcome === 'already_in_ap') skipped++;
      else { await markFailed(companyId, inv.id); failed++; }
    }

    return await completeRun(runId, companyId, sageInvoices.length, succeeded, failed, skipped, vatNotStated);
  });
}

/**
 * The live bill this staged row already is, if any. `null` when there is
 * none; `'conflict'` when a live bill under this number is a DIFFERENT
 * document — it carries another Sage id, or its total differs — so the row is
 * failed for a person to resolve rather than merged. A bill found by number
 * with no Sage id (captured by hand before the migration) is adopted only when
 * its total matches, and it takes the staged row's Sage id so the next staged
 * row under that number conflicts instead of joining it. An ARCHIVED bill
 * with this Sage id (any supplier), or of this supplier under this number,
 * also conflicts.
 */
async function findExistingBill(
  companyId: string, supplierId: string, sageId: string | null, invNumber: string, totalAmount: number,
): Promise<string | 'conflict' | null> {
  const [bill] = (await sql`
    SELECT id, sage_invoice_id, total_amount FROM supplier_invoices
    WHERE company_id = ${companyId}::UUID AND supplier_id = ${supplierId}::UUID
      AND deleted_at IS NULL
      AND (
        (${sageId}::TEXT IS NOT NULL AND sage_invoice_id = ${sageId}::TEXT)
        OR invoice_number = ${invNumber}
      )
    ORDER BY (sage_invoice_id = ${sageId}::TEXT) DESC NULLS LAST, created_at, id
    LIMIT 1
  `) as DbRow[];
  if (!bill) {
    // An archived bill (executeArchive deletes old paid bills, and the staging
    // link goes NULL with it, 694) is still this document: a reset + re-run
    // must not book the settled debt again as a live bill. The Sage id is
    // matched company-wide: a supplier re-created under the same name after
    // the archive is a new supplier_id, and the settled bill would come back.
    const [archived] = (await sql`
      SELECT 1 FROM archive_supplier_invoices
      WHERE company_id = ${companyId}::UUID
        AND ((${sageId}::TEXT IS NOT NULL AND sage_invoice_id = ${sageId}::TEXT)
          OR (supplier_id = ${supplierId}::UUID AND invoice_number = ${invNumber}))
      LIMIT 1
    `) as DbRow[];
    return archived ? 'conflict' : null;
  }
  const existingSageId = bill.sage_invoice_id ? String(bill.sage_invoice_id) : null;
  if (existingSageId && sageId && existingSageId !== sageId) return 'conflict';
  if (Math.abs(Number(bill.total_amount) - totalAmount) > 0.005) return 'conflict';
  if (!existingSageId && sageId) {
    await sql`
      UPDATE supplier_invoices SET sage_invoice_id = ${sageId}
      WHERE id = ${String(bill.id)}::UUID AND company_id = ${companyId}::UUID
    `;
  }
  return String(bill.id);
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
