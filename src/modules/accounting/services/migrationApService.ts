/**
 * Migration AP Service — Supplier Invoice Import
 * PRD: Customer Migration Wizard — Phase 1
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { createJournalEntry, postJournalEntry } from './journalEntryService';
import { getSystemAccountId } from './systemAccountResolver';
import { updateSession, type ImportResult, type MigrationError } from './migrationService';
import { matchContact } from './migrationImportService';
type Row = Record<string, unknown>;


export interface APInvoiceRow {
  invoiceNumber: string;
  supplierName: string;
  invoiceDate: string;
  dueDate: string;
  subtotal: number;
  taxAmount: number;
  totalAmount: number;
  amountPaid: number;
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

  const apAccountId      = await getSystemAccountId('payable');
  const expenseAccountId = await getSystemAccountId('default_expense');
  const vatInputId       = await getSystemAccountId('vat_input');

  const supRows = (await sql`
    SELECT id, COALESCE(company_name, name) AS name FROM suppliers
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

      const balance = inv.totalAmount - (inv.amountPaid ?? 0);
      const status  = balance <= 0 ? 'paid' : inv.amountPaid > 0 ? 'partially_paid' : 'approved';

      const invRows = (await sql`
        INSERT INTO supplier_invoices (
          company_id, supplier_id, invoice_number, invoice_date, due_date,
          subtotal, tax_amount, total_amount, amount_paid, balance_due,
          status, reference, created_by
        ) VALUES (
          ${companyId}::UUID, ${supplierId}::UUID, ${inv.invoiceNumber},
          ${inv.invoiceDate}::DATE, ${inv.dueDate}::DATE,
          ${inv.subtotal}, ${inv.taxAmount}, ${inv.totalAmount},
          ${inv.amountPaid ?? 0}, ${balance}, ${status},
          ${inv.reference ?? null}, ${userId}::UUID
        )
        ON CONFLICT DO NOTHING
        RETURNING id
      `) as Row[];

      if (invRows.length === 0) { skipped++; continue; }
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

      const entry = await createJournalEntry(companyId, {
        entryDate: inv.invoiceDate,
        description: `Migrated AP invoice ${inv.invoiceNumber}`,
        source: 'auto_migration',
        sourceDocumentId: invoiceId,
        lines: journalLines,
      }, userId);
      await postJournalEntry(companyId, entry.id, userId);
      imported++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push({ step: 'ap_invoices', row: i, message: msg });
      skipped++;
    }
  }

  await updateSession(sessionId, companyId, { apInvoicesImported: imported, stepsCompleted: { ap_invoices: true }, errors });
  log.info('AP invoices imported', { companyId, imported, skipped }, 'migration');
  return { imported, skipped, errors };
}
