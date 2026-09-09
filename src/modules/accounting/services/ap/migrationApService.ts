/**
 * Migration AP Service — Supplier Invoice Import
 * PRD: Customer Migration Wizard — Phase 1
 */

import { sql, withSavepoint } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { createJournalEntry, postJournalEntry } from '../gl/journalEntryService';
import { getSystemAccountId } from '../gl/systemAccountResolver';
import { updateSession, type ImportResult, type MigrationError } from '../core/migrationService';
import { matchContact } from '../core/migrationImportService';
import { buildTakeOnLines, resolveTakeOnClearingAccountId } from '../core/migrationPostingSupport';
import { computeFingerprint } from '../capture/captureDeduplicationService';
type Row = DbRow;


export interface APInvoiceRow {
  invoiceNumber: string;
  supplierName: string;
  invoiceDate: string;
  dueDate: string;
  subtotal: number;
  taxAmount: number;
  totalAmount: number;
  /** Optional: absent and 0 mean the same thing — nothing has been paid. */
  amountPaid?: number;
  reference?: string;
}

// ── AP Invoice Import ────────────────────────────────────────────────────────

export async function importAPInvoices(
  companyId: string,
  sessionId: string,
  invoices: APInvoiceRow[],
  userId: string,
): Promise<ImportResult> {
  const errors: MigrationError[] = [];
  const warnings: MigrationError[] = [];
  let imported = 0;
  let skipped = 0;

  // No default_expense and no vat_input: a take-on document posts neither. See
  // migrationPostingSupport for why re-declaring the VAT is the deciding reason.
  const apAccountId       = await getSystemAccountId('payable', companyId);
  const clearingAccountId = await resolveTakeOnClearingAccountId(companyId);

  const supRows = (await sql`
    SELECT id, COALESCE(company_name, name) AS name, vat_number FROM suppliers
    WHERE company_id = ${companyId}::UUID
  `) as Row[];

  for (let i = 0; i < invoices.length; i++) {
    const inv = invoices[i]!;
    try {
      const supplierId = matchContact(inv.supplierName, supRows);
      if (!supplierId) {
        errors.push({ step: 'ap_invoices', row: i, field: 'supplierName', message: `Supplier not found: ${inv.supplierName}` });
        skipped++;
        continue;
      }

      // R-002. A take-on entry carries ONE figure — the outstanding amount — so
      // subtotal and tax never have to balance against anything, and cents of
      // drift in a source export cost nothing. Refusing at a cent lost real
      // invoices over the exporter's own rounding. Import up to 5c with a
      // warning; refuse beyond that, where the file is wrong rather than rounded.
      const amountsDrift = Math.abs(inv.subtotal + inv.taxAmount - inv.totalAmount);
      if (amountsDrift > 0.005) {
        const detail = `subtotal ${inv.subtotal.toFixed(2)} + tax ${inv.taxAmount.toFixed(2)} != total ${inv.totalAmount.toFixed(2)}`;
        if (amountsDrift > 0.05) {
          errors.push({
            step: 'ap_invoices', row: i, field: 'totalAmount',
            message: `Amounts do not add up for ${inv.invoiceNumber}: ${detail}`,
          });
          skipped++;
          continue;
        }
        warnings.push({
          step: 'ap_invoices', row: i, field: 'totalAmount',
          message: `Imported with a rounding difference: ${inv.invoiceNumber} — ${detail}`,
        });
      }

      const amountPaid = inv.amountPaid ?? 0;
      const balance = inv.totalAmount - amountPaid;
      const status  = balance <= 0 ? 'paid' : amountPaid > 0 ? 'partially_paid' : 'approved';

      const matchedSupplier = supRows.find(s => String(s.id) === supplierId);
      const migFingerprint = computeFingerprint(
        matchedSupplier?.vat_number ?? null,
        inv.invoiceNumber,
        inv.totalAmount,
      );

      // Every statement for this row runs inside its own savepoint: a caught
      // per-row failure must not leave the request transaction aborted, or the
      // updateSession below dies with 25P02 and the whole route 500s.
      const rowImported = await withSavepoint('mig_ap_invoice_row', async () => {
        // Idempotency by lookup, not by constraint. duplicate_fingerprint cannot
        // carry a unique index: it is lower(vat|invoice_number|total) with
        // 'no-vat'/'no-inv'/'0' substituted for missing parts, so every row
        // missing the same parts collapses onto one string — production holds
        // groups of 55-79 live invoices sharing a fingerprint. This is a
        // read-then-write and is therefore not safe against two imports of the
        // same file running at the same instant; the wizard is a single
        // operator-driven step per company, and there is no constraint to lean
        // on. See migration 625.
        const already = (await sql`
          SELECT id FROM supplier_invoices
          WHERE company_id = ${companyId}::UUID
            AND supplier_id = ${supplierId}::UUID
            AND duplicate_fingerprint = ${migFingerprint}
            AND deleted_at IS NULL
          LIMIT 1
        `) as Row[];
        if (already.length > 0) {
          errors.push({
            step: 'ap_invoices', row: i, field: 'invoiceNumber',
            message: `Already imported: ${inv.invoiceNumber} for this supplier and amount`,
          });
          return false;
        }

        const invRows = (await sql`
          INSERT INTO supplier_invoices (
            company_id, supplier_id, invoice_number, invoice_date, due_date,
            subtotal, tax_amount, total_amount, amount_paid,
            status, reference, created_by,
            duplicate_fingerprint
          ) VALUES (
            ${companyId}::UUID, ${supplierId}::UUID, ${inv.invoiceNumber},
            ${inv.invoiceDate}::DATE, ${inv.dueDate}::DATE,
            ${inv.subtotal}, ${inv.taxAmount}, ${inv.totalAmount},
            ${amountPaid}, ${status},
            ${inv.reference ?? null}, ${userId}::UUID,
            ${migFingerprint}
          )
          RETURNING id
        `) as Row[];

        if (invRows.length === 0) return false;
        const invoiceId = String(invRows[0]!.id);

        // One take-on entry for what is still outstanding. A bill settled in
        // full before the cutover has nothing to take on: it is created as a
        // document, with amount_paid, and posts nothing.
        const journalLines = buildTakeOnLines(
          apAccountId, clearingAccountId, balance, 'payable', inv.invoiceNumber,
        );
        if (journalLines.length === 0) return true;

        // No sourceDocumentId: gl_journal_entries.source_document_id has an FK
        // to captured_documents(id) only (migration 409); the invoice's own id
        // would violate it. The invoice <-> journal entry link is instead
        // persisted below via supplier_invoices.gl_journal_entry_id — same
        // column supplierInvoiceWorkflowService/sageMigrationCommitService use
        // for a supplier invoice's own posting entry; safe here because a
        // migrated invoice is inserted pre-approved and never goes through
        // that flow afterward.
        const entry = await createJournalEntry(companyId, {
          entryDate: inv.invoiceDate,
          description: `Take-on AP invoice ${inv.invoiceNumber}`,
          source: 'auto_migration',
          lines: journalLines,
        }, userId);
        await postJournalEntry(companyId, entry.id, userId);
        await sql`
          UPDATE supplier_invoices SET gl_journal_entry_id = ${entry.id}::UUID
          WHERE id = ${invoiceId}::UUID AND company_id = ${companyId}::UUID
        `;

        return true;
      });
      if (rowImported) imported++; else skipped++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push({ step: 'ap_invoices', row: i, message: msg });
      skipped++;
    }
  }

  await updateSession(sessionId, companyId, { apInvoicesImported: imported, stepsCompleted: { ap_invoices: true }, errors });
  log.info('AP invoices imported', { companyId, imported, skipped }, 'migration');
  return { imported, skipped, errors, warnings };
}
