/**
 * Migration Import Service — AR Invoices
 * PRD: Customer Migration Wizard — Phase 1
 *
 * AP invoice import is in migrationApService.ts; opening balances are in
 * migrationWizardOpeningBalanceService.ts.
 */

import { sql, withSavepoint } from '@/lib/neon';
import { log } from '@/lib/logger';
import { createJournalEntry, postJournalEntry } from '../gl/journalEntryService';
import { getSystemAccountId } from '../gl/systemAccountResolver';
import { updateSession, type ImportResult, type ImportRowContext, type MigrationError } from './migrationService';
import { assertNoOpeningControlTotal, buildTakeOnLines, lockMigrationImport, resolveTakeOnClearingAccountId, rethrowIfConflictTargetMissing } from './migrationPostingSupport';
import { matchContact } from './migrationContactMatch';
import type { DbRow } from '@/types/db';

// Re-exported: migrationApService and the wizard's unit tests have imported
// matchContact from here since before it moved to its own module.
export { matchContact };

// Re-exported: the opening-balance step moved to its own module when the
// take-on work pushed this file past the 300-line cap. Every caller — the route,
// core/index.ts and the wizard's tests — has imported it from here.
export { importOpeningBalances, type OpeningBalanceRow } from './migrationWizardOpeningBalanceService';

export interface ARInvoiceRow {
  invoiceNumber: string;
  customerName: string;
  invoiceDate: string;
  dueDate: string;
  subtotal: number;
  taxAmount: number;
  totalAmount: number;
  /** Optional: absent and 0 mean the same thing — nothing has been paid. */
  amountPaid?: number;
  reference?: string;
}

// ── AR Invoice Import ────────────────────────────────────────────────────────

export async function importARInvoices(
  companyId: string,
  sessionId: string,
  invoices: ARInvoiceRow[],
  userId: string,
  rowContext?: ImportRowContext,
): Promise<ImportResult> {
  // Rows the route's schema already rejected lead the list; they were never
  // handed to this loop but they belong to this step's report and to the
  // session, which is the only place the operator sees them after a reload.
  const errors: MigrationError[] = [...(rowContext?.priorErrors ?? [])];
  const warnings: MigrationError[] = [];
  /** The position of the service's row `i` in the operator's file. */
  const fileRow = (i: number) => rowContext?.sourceRows?.[i] ?? i;
  let imported = 0;
  let skipped = errors.length;

  // Before any read: the idempotency check below is a read-then-write.
  await lockMigrationImport(companyId);
  await assertNoOpeningControlTotal(companyId, sessionId, 'receivable');

  // No default_revenue and no vat_output: a take-on document posts neither. See
  // migrationPostingSupport for why re-declaring the VAT is the deciding reason.
  const arAccountId       = await getSystemAccountId('receivable', companyId);
  const clearingAccountId = await resolveTakeOnClearingAccountId(companyId);

  const custRows = (await sql`
    SELECT id, name FROM customers WHERE company_id = ${companyId}::UUID
  `) as DbRow[];

  // Migration 530 stores the origin of a document IsaFlow did not create as a
  // pair: external_ref plus the system it came from. Writing the reference
  // without the system leaves it unattributable.
  const sessRows = (await sql`
    SELECT source_system FROM migration_sessions
    WHERE id = ${sessionId}::UUID AND company_id = ${companyId}::UUID
  `) as DbRow[];
  const sourceSystem = sessRows.length > 0 ? String(sessRows[0]!.source_system) : 'csv_import';

  for (let i = 0; i < invoices.length; i++) {
    const inv = invoices[i]!;
    try {
      const customerId = matchContact(inv.customerName, custRows);
      if (!customerId) {
        errors.push({ step: 'ar_invoices', row: fileRow(i), field: 'customerName', message: `Customer not found: ${inv.customerName}` });
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
            step: 'ar_invoices', row: fileRow(i), field: 'totalAmount',
            message: `Amounts do not add up for ${inv.invoiceNumber}: ${detail}`,
          });
          skipped++;
          continue;
        }
        warnings.push({
          step: 'ar_invoices', row: fileRow(i), field: 'totalAmount',
          message: `Imported with a rounding difference: ${inv.invoiceNumber} — ${detail}`,
        });
      }

      const amountPaid = inv.amountPaid ?? 0;
      const balance = inv.totalAmount - amountPaid;
      const status  = balance <= 0 ? 'paid' : amountPaid > 0 ? 'partially_paid' : 'approved';

      // customer_invoices has no `reference` column: migration 530 added
      // external_ref for exactly this — the source system's own reference on
      // a document IsaFlow did not originate.
      // Every statement for this row runs inside its own savepoint: a caught
      // per-row failure must not leave the request transaction aborted, or the
      // updateSession below dies with 25P02 and the whole route 500s.
      const rowImported = await withSavepoint('mig_ar_invoice_row', async () => {
        const invRows = (await sql`
          INSERT INTO customer_invoices (
            company_id, customer_id, invoice_number, invoice_date, due_date,
            subtotal, tax_amount, total_amount, amount_paid,
            status, external_ref, external_system, created_by
          ) VALUES (
            ${companyId}::UUID, ${customerId}::UUID, ${inv.invoiceNumber},
            ${inv.invoiceDate}::DATE, ${inv.dueDate}::DATE,
            ${inv.subtotal}, ${inv.taxAmount}, ${inv.totalAmount},
            ${amountPaid}, ${status},
            ${inv.reference ?? null}, ${inv.reference ? sourceSystem : null}, ${userId}::UUID
          )
          ON CONFLICT (company_id, invoice_number) DO NOTHING
          RETURNING id
        `) as DbRow[];

        // uq_customer_invoices_company_number swallowed the row silently; the
        // operator saw a skip count with no reason and no invoice number.
        if (invRows.length === 0) {
          errors.push({
            step: 'ar_invoices', row: fileRow(i), field: 'invoiceNumber',
            message: `Invoice number already exists: ${inv.invoiceNumber}`,
          });
          return false;
        }
        const invoiceId = String(invRows[0]!.id);

        // One take-on entry for what is still outstanding. An invoice settled in
        // full before the cutover has nothing to take on: it is created as a
        // document, with amount_paid, and posts nothing.
        const journalLines = buildTakeOnLines(
          arAccountId, clearingAccountId, balance, 'receivable', inv.invoiceNumber,
        );
        if (journalLines.length === 0) return true;

        // No sourceDocumentId: gl_journal_entries.source_document_id has an FK
        // to captured_documents(id) only (migration 409); the invoice's own id
        // would violate it. The invoice <-> journal entry link is instead
        // persisted below via customer_invoices.gl_journal_entry_id — same
        // column postCustomerInvoiceToGL uses for a normally-created invoice's
        // own posting entry; safe here because a migrated invoice is inserted
        // pre-approved and never goes through that flow afterward.
        const entry = await createJournalEntry(companyId, {
          entryDate: inv.invoiceDate,
          description: `Take-on AR invoice ${inv.invoiceNumber}`,
          source: 'auto_migration',
          lines: journalLines,
        }, userId);
        await postJournalEntry(companyId, entry.id, userId);
        await sql`
          UPDATE customer_invoices SET gl_journal_entry_id = ${entry.id}::UUID
          WHERE id = ${invoiceId}::UUID AND company_id = ${companyId}::UUID
        `;

        return true;
      });
      if (rowImported) imported++; else skipped++;
    } catch (err) {
      rethrowIfConflictTargetMissing(err, 'uq_customer_invoices_company_number');
      const msg = err instanceof Error ? err.message : String(err);
      errors.push({ step: 'ar_invoices', row: fileRow(i), message: msg });
      skipped++;
    }
  }

  // Warnings ride in the same column as errors, marked, because they must
  // survive a page reload exactly as errors do: a row that imported with
  // rounding drift is the whole point of R-002 and is otherwise invisible.
  await updateSession(sessionId, companyId, {
    arInvoicesImported: imported,
    stepsCompleted: { ar_invoices: true },
    errors: [...errors, ...warnings.map(w => ({ ...w, severity: 'warning' as const }))],
  });
  log.info('AR invoices imported', { companyId, imported, skipped }, 'migration');
  return { imported, skipped, errors, warnings };
}
