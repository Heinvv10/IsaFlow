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
import { resolveSettlementAccountId, rethrowIfDuplicateIndexMissing } from '../core/migrationPostingSupport';
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
  let imported = 0;
  let skipped = 0;

  const apAccountId      = await getSystemAccountId('payable', companyId);
  const expenseAccountId = await getSystemAccountId('default_expense', companyId);
  const vatInputId       = await getSystemAccountId('vat_input', companyId);

  const settlementAccountId = await resolveSettlementAccountId(
    companyId,
    invoices.some(inv => (inv.amountPaid ?? 0) > 0),
  );

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

      // M4/R-002: the journal is built from subtotal + tax and credited with
      // totalAmount, so a source file whose three amounts disagree by a cent
      // produces an unbalanced entry that postJournalEntry rejects — losing the
      // document with a raw Postgres-flavoured message. Reject it here instead,
      // naming all three amounts so the operator can correct the file.
      if (Math.abs(inv.subtotal + inv.taxAmount - inv.totalAmount) > 0.005) {
        errors.push({
          step: 'ap_invoices', row: i, field: 'totalAmount',
          message: `Amounts do not add up for ${inv.invoiceNumber}: subtotal ${inv.subtotal.toFixed(2)} + tax ${inv.taxAmount.toFixed(2)} != total ${inv.totalAmount.toFixed(2)}`,
        });
        skipped++;
        continue;
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
          ON CONFLICT (company_id, supplier_id, duplicate_fingerprint)
            WHERE duplicate_fingerprint IS NOT NULL AND deleted_at IS NULL
          DO NOTHING
          RETURNING id
        `) as Row[];

        // Re-running the wizard after a partial failure is the obvious user
        // action; without a reason on the skip the operator cannot tell a
        // duplicate from a lost document.
        if (invRows.length === 0) {
          errors.push({
            step: 'ap_invoices', row: i, field: 'invoiceNumber',
            message: `Already imported: ${inv.invoiceNumber} for this supplier and amount`,
          });
          return false;
        }
        const invoiceId = String(invRows[0]!.id);

        // Post GL: DR Expense + VAT Input, CR Payable
        const journalLines = [
          { glAccountId: expenseAccountId, debit: inv.subtotal,   credit: 0,              description: `Expense — ${inv.invoiceNumber}` },
          { glAccountId: apAccountId,      debit: 0,              credit: inv.totalAmount, description: `AP — ${inv.invoiceNumber}` },
        ];
        if (inv.taxAmount > 0) {
          // DR VAT Input (claimable input tax), AP credit already equals totalAmount
          journalLines.push({ glAccountId: vatInputId, debit: inv.taxAmount, credit: 0, description: `VAT Input — ${inv.invoiceNumber}` });
        }

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
          description: `Migrated AP invoice ${inv.invoiceNumber}`,
          source: 'auto_migration',
          lines: journalLines,
        }, userId);
        await postJournalEntry(companyId, entry.id, userId);
        await sql`
          UPDATE supplier_invoices SET gl_journal_entry_id = ${entry.id}::UUID
          WHERE id = ${invoiceId}::UUID AND company_id = ${companyId}::UUID
        `;

        // The origination entry credits payable with the FULL total, but the
        // invoice is stored with the amount already settled before the cutover.
        // Without this leg the AP control account and the AP subledger disagree
        // by exactly amountPaid. The contra is opening balance equity — the
        // clearing account for everything that happened before the cutover; a
        // bank leg would invent a cash movement the bank's own opening balance
        // already accounts for. The account is resolved once for the whole
        // step, so a company without one fails the step with a single message
        // instead of failing once per part-paid row.
        if (amountPaid > 0 && settlementAccountId) {
          const settlement = await createJournalEntry(companyId, {
            entryDate: inv.invoiceDate,
            description: `Migrated AP invoice ${inv.invoiceNumber} — settled before cutover`,
            source: 'auto_migration',
            lines: [
              { glAccountId: apAccountId,  debit: amountPaid, credit: 0,          description: `AP settled — ${inv.invoiceNumber}` },
              { glAccountId: settlementAccountId, debit: 0,   credit: amountPaid, description: `Opening balance equity — ${inv.invoiceNumber}` },
            ],
          }, userId);
          await postJournalEntry(companyId, settlement.id, userId);
        }
        return true;
      });
      if (rowImported) imported++; else skipped++;
    } catch (err) {
      rethrowIfDuplicateIndexMissing(err);
      const msg = err instanceof Error ? err.message : String(err);
      errors.push({ step: 'ap_invoices', row: i, message: msg });
      skipped++;
    }
  }

  await updateSession(sessionId, companyId, { apInvoicesImported: imported, stepsCompleted: { ap_invoices: true }, errors });
  log.info('AP invoices imported', { companyId, imported, skipped }, 'migration');
  return { imported, skipped, errors };
}
