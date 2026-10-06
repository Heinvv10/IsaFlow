/**
 * Sage Customer Invoice Importer
 * Moves sage_customer_invoices → customer_invoices.
 * Matches Sage's approach: invoices are standalone AR documents,
 * no separate GL journal entries are created per invoice.
 */

import { sql, withSavepoint } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { MigrationRun } from './sageMigrationService';
import { startRun, completeRun, withRunRecovery } from './sageMigrationService';
import { lockMigrationImport } from './migrationPostingSupport';
import { deriveSageVat, SAGE_VAT_NOT_STATED_NOTE } from '../shared/sageVatDerivation';
import { assertMayImportOpenBills, withApprovalGateExempt } from '../gl/approvalGateExempt';

type RowOutcome = 'imported' | 'already_in_ar' | 'credit_note' | 'failed';

/** Statuses whose invoice stands in AR; a draft or cancelled one does not. */
const IN_AR_STATUSES = new Set(['approved', 'sent', 'paid', 'partially_paid', 'overdue']);

/**
 * Import sage_customer_invoices into customer_invoices.
 *
 * R-101: the staging table holds only (sage_id, invoice_number, customer_name,
 * invoice_date, total_amount). An earlier revision SELECTed columns it has
 * never had, so every run died on 42703 before its loop — the customer twin
 * of R-021, and mapped the same way:
 *   - customer: the ONE live customer of that name (case-insensitive, ends
 *     trimmed). None, or more than one, fails the row.
 *   - due date: invoice date plus the customer's payment_terms days; no terms,
 *     no due date.
 *   - VAT: none stated, so none recorded and the invoice flagged (R-089).
 *   - payment state: unpaid and 'approved'. Staging carries no payment.
 *   - a negative total is a Sage credit note. It is not booked and not
 *     'failed': it is marked 'credit_note', so a later credit-note import can
 *     find it and a genuine failure stays distinguishable (R-119).
 *   - a zero or non-numeric total fails the row, and so does a missing
 *     invoice date (the ageing would date the debt by created_at).
 *   - the Sage id is kept as external_ref / external_system = 'sage', and the
 *     Sage number as external_document_number (migration 530).
 *
 * A re-run after `resetMigration` must not book the invoice twice; see
 * `findExistingInvoice`. The run holds the company's migration import lock.
 */
export async function importCustomerInvoices(companyId: string, userId: string): Promise<MigrationRun> {
  // R-035 PR4: every staged invoice is open (amount_paid 0) — refuse before the run is recorded.
  await assertMayImportOpenBills(companyId, userId, 'customer_invoice');
  const runId = await startRun('customer_invoice_import', userId, companyId);

  return withRunRecovery(runId, companyId, async () => {
    await lockMigrationImport(companyId);
    const sageInvoices = (await sql`
      SELECT id, sage_id, invoice_number, customer_name, invoice_date, total_amount
      FROM sage_customer_invoices
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
        // Each row in its own savepoint, so a failing row rolls back alone and
        // its 'failed' marker lands on a usable transaction (K-090).
        outcome = await withSavepoint('sage_customer_invoice_record', async (): Promise<RowOutcome> => {
          const totalAmount = Number(inv.total_amount);
          if (totalAmount < 0) {
            log.info('Sage customer document has a negative total; set aside as a credit note', {
              companyId, stagingId: inv.id, totalAmount,
            }, 'accounting');
            return 'credit_note';
          }
          if (!(totalAmount > 0)) {
            log.warn('Sage customer invoice has no positive total; not booked', {
              companyId, stagingId: inv.id, totalAmount,
            }, 'accounting');
            return 'failed';
          }

          if (!inv.invoice_date) {
            log.warn('Sage customer invoice has no invoice date; not booked', {
              companyId, stagingId: inv.id,
            }, 'accounting');
            return 'failed';
          }

          const customerName = String(inv.customer_name ?? '').trim();
          const customers = (await sql`
            SELECT id, payment_terms
            FROM customers
            WHERE company_id = ${companyId}::UUID
              AND deleted_at IS NULL
              AND lower(btrim(name)) = lower(${customerName})
            LIMIT 2
          `) as DbRow[];
          if (customers.length !== 1) {
            log.warn('Sage customer invoice does not name exactly one customer on this company', {
              companyId, stagingId: inv.id, customerName, matches: customers.length,
            }, 'accounting');
            return 'failed';
          }
          const customer = customers[0]!;
          const customerId = String(customer.id);
          const sageId = inv.sage_id ? String(inv.sage_id) : null;
          const invNumber = inv.invoice_number ? String(inv.invoice_number) : `SAGE-${sageId ?? String(inv.id)}`;

          const existing = await findExistingInvoice(
            companyId, customerId, sageId, invNumber, inv.invoice_number ? String(inv.invoice_number) : null,
            totalAmount, inv.invoice_date,
          );
          if (existing === 'conflict') {
            log.warn('The invoice number is held by a different document (customer, Sage id, total or state)', {
              companyId, stagingId: inv.id, customerId, invNumber, sageId, totalAmount,
            }, 'accounting');
            return 'failed';
          }

          let invoiceId: string;
          let rowVatNotStated = false;
          if (existing) {
            invoiceId = existing;
          } else {
            const vat = deriveSageVat(null, null, totalAmount);
            rowVatNotStated = vat.vatNotStated;
            const paymentTerms = customer.payment_terms == null ? null : Number(customer.payment_terms);
            // R-035 Q1: issued in Sage, so exempt from the approval backstop.
            const newInv = (await withApprovalGateExempt({ companyId, userId, open: true, documentType: 'customer_invoice' }, () => sql`
              INSERT INTO customer_invoices (
                company_id, invoice_number, customer_id, invoice_date, due_date,
                subtotal, tax_rate, tax_amount, total_amount, amount_paid, status,
                external_ref, external_document_number, external_system, notes, created_by
              ) VALUES (
                ${companyId}::UUID, ${invNumber}, ${customerId}::UUID,
                ${inv.invoice_date}, ${inv.invoice_date}::DATE + ${paymentTerms}::INT,
                ${vat.subtotal.toFixed(2)}, ${vat.taxRate}, ${vat.taxAmount.toFixed(2)}, ${totalAmount},
                0, 'approved',
                ${sageId}, ${inv.invoice_number ?? null}, ${sageId ? 'sage' : null},
                ${rowVatNotStated ? SAGE_VAT_NOT_STATED_NOTE : null}, ${userId}
              ) RETURNING id
            `)) as DbRow[];
            invoiceId = String(newInv[0]!.id);
          }

          await sql`
            UPDATE sage_customer_invoices
            SET migration_status = 'imported', gl_customer_invoice_id = ${invoiceId}::UUID
            WHERE id = ${inv.id} AND company_id = ${companyId}::UUID
          `;

          // Counted only once the row has landed (review-r089-r1.md LOW-3).
          if (rowVatNotStated) vatNotStated++;
          return existing ? 'already_in_ar' : 'imported';
        });
      } catch (err) {
        log.error('Failed to import customer invoice', { invoiceId: inv.id, error: err }, 'accounting');
        outcome = 'failed';
      }

      if (outcome === 'imported') succeeded++;
      else if (outcome === 'already_in_ar') skipped++;
      else if (outcome === 'credit_note') { await markStatus(companyId, inv.id, 'credit_note'); skipped++; }
      else { await markStatus(companyId, inv.id, 'failed'); failed++; }
    }

    return await completeRun(runId, companyId, sageInvoices.length, succeeded, failed, skipped, vatNotStated);
  });
}

/**
 * The live invoice this staged row already is, if any. `null` when there is
 * none; `'conflict'` when the number is held by a DIFFERENT document, so the
 * row is failed for a person to resolve rather than merged.
 *
 * Invoice numbers are unique per company, including soft-deleted and cancelled
 * invoices (uq_customer_invoices_company_number), so the number is looked up
 * across all of them. Any holder that is not this customer's live, in-AR
 * invoice (not draft, pending approval or cancelled) of the same Sage id and
 * total is a conflict — never a 23505 mid-run, and never a Sage debt linked to
 * a document the ageing does not carry. A live invoice already carrying the
 * Sage id is preferred over a number match, and is a conflict when it sits on
 * another customer: that is the same Sage document resolved to a different
 * customer this time (a rename between runs), and booking it again would
 * count the debt twice. An invoice with no external reference (captured by
 * hand before the migration) is adopted only when customer, total and invoice
 * date agree,
 * and takes the Sage id and number, so the next staged row under that number
 * conflicts instead of joining it. An external reference from another system
 * is a different document's identity and conflicts.
 * A number held by an ARCHIVED invoice also conflicts (see below).
 */
async function findExistingInvoice(
  companyId: string, customerId: string, sageId: string | null, invNumber: string,
  sageNumber: string | null, totalAmount: number, invoiceDate: unknown,
): Promise<string | 'conflict' | null> {
  const [found] = (await sql`
    SELECT id, customer_id, total_amount, status, deleted_at, external_ref, external_system,
      invoice_date IS NOT DISTINCT FROM ${invoiceDate}::DATE AS same_date
    FROM customer_invoices
    WHERE company_id = ${companyId}::UUID
      AND (
        (${sageId}::TEXT IS NOT NULL AND deleted_at IS NULL
          AND external_system = 'sage' AND external_ref = ${sageId}::TEXT)
        OR invoice_number = ${invNumber}
      )
    ORDER BY COALESCE(external_system = 'sage' AND external_ref = ${sageId}::TEXT AND deleted_at IS NULL, FALSE) DESC,
             created_at, id
    LIMIT 1
  `) as DbRow[];
  if (!found) return null;
  if (found.deleted_at || !IN_AR_STATUSES.has(String(found.status))) return 'conflict';
  if (String(found.customer_id) !== customerId) return 'conflict';
  if (Math.abs(Number(found.total_amount) - totalAmount) > 0.005) return 'conflict';
  const ref = found.external_ref == null ? null : String(found.external_ref);
  if (ref !== null && (found.external_system !== 'sage' || ref !== sageId)) return 'conflict';
  // Adopting an unreferenced invoice also needs the same date: a monthly fee
  // under a colliding number, customer and amount is a different document.
  if (ref === null && found.same_date !== true) return 'conflict';
  if (ref === null && sageId) {
    await sql`
      UPDATE customer_invoices
      SET external_ref = ${sageId}, external_system = 'sage',
          external_document_number = COALESCE(external_document_number, ${sageNumber})
      WHERE id = ${String(found.id)}::UUID AND company_id = ${companyId}::UUID
    `;
  }
  return String(found.id);
}

/** Set one staging row's migration_status, scoped by company_id. */
async function markStatus(companyId: string, stagingId: unknown, status: 'failed' | 'credit_note'): Promise<void> {
  await sql`
    UPDATE sage_customer_invoices SET migration_status = ${status}
    WHERE id = ${stagingId} AND company_id = ${companyId}::UUID
  `;
}
