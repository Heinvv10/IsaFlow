/**
 * Migration AP Service — Supplier Invoice Import
 * PRD: Customer Migration Wizard — Phase 1
 */

import { sql, withSavepoint } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { createJournalEntry, postJournalEntry } from '../gl/journalEntryService';
import { getSystemAccountId } from '../gl/systemAccountResolver';
import { updateSession, type ImportResult, type ImportRowContext, type MigrationError } from '../core/migrationService';
import { matchContact } from '../core/migrationImportService';
import { assertNoOpeningControlTotal, buildTakeOnLines, lockMigrationImport, resolveTakeOnClearingAccountId } from '../core/migrationPostingSupport';
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
  /**
   * The wizard page's manual supplier correction, which used to be sent and
   * silently dropped: the row schema stripped it and the service matched on the
   * name regardless, so the operator's fix in the UI did nothing. Empty means
   * the page had nothing to send.
   */
  supplierId?: string;
}

// ── AP Invoice Import ────────────────────────────────────────────────────────

export async function importAPInvoices(
  companyId: string,
  sessionId: string,
  invoices: APInvoiceRow[],
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
  await assertNoOpeningControlTotal(companyId, sessionId, 'payable');

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
      // The page's manual correction wins over the name match, but only after
      // it is checked against THIS company's suppliers — it arrives from the
      // browser and is otherwise an unscoped id.
      const overrideId = inv.supplierId
        ? supRows.find(s => String(s.id) === inv.supplierId)?.id
        : undefined;
      if (inv.supplierId && !overrideId) {
        errors.push({ step: 'ap_invoices', row: fileRow(i), field: 'supplierId', message: `Supplier not found for this company: ${inv.supplierId}` });
        skipped++;
        continue;
      }
      const supplierId = overrideId ? String(overrideId) : matchContact(inv.supplierName, supRows);
      if (!supplierId) {
        errors.push({ step: 'ap_invoices', row: fileRow(i), field: 'supplierName', message: `Supplier not found: ${inv.supplierName}` });
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
            step: 'ap_invoices', row: fileRow(i), field: 'totalAmount',
            message: `Amounts do not add up for ${inv.invoiceNumber}: ${detail}`,
          });
          skipped++;
          continue;
        }
        warnings.push({
          step: 'ap_invoices', row: fileRow(i), field: 'totalAmount',
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
        // Idempotency by lookup, not by constraint, and keyed on the bill's
        // IDENTITY — supplier plus invoice number — rather than on its amount.
        // The fingerprint carries the total (lower(vat|invoice_number|total)),
        // so the ordinary operator loop — import, notice a wrong total, correct
        // the CSV, re-run — produced a different key, missed, and posted the
        // same bill a second time against the AP control account. AR is spared
        // only because uq_customer_invoices_company_number (migration 220)
        // refuses it; production has no equivalent index on supplier_invoices,
        // and cannot get one: rows with no invoice number are legitimate and
        // repeat — APInvoiceRowSchema allows a blank number for exactly that
        // reason, so this fallback is on the live path. So the number is the
        // key only when there IS one, and a blank-numbered row falls back to
        // the fingerprint, which is the most identity it has. This is a
        // read-then-write and is therefore not safe against two imports of the
        // same file running at the same instant; lockMigrationImport above is
        // what serialises them.
        //
        // Compared case-INSENSITIVELY. computeFingerprint lowercases, so the
        // key this replaced ignored case; keying on the raw column would have
        // let a re-exported CSV whose number came back as `inv-1` rather than
        // `INV-1` mint a second bill and a second take-on journal.
        //
        // NO `deleted_at IS NULL`. Soft-deleting a migrated bill does not touch
        // its take-on entry — softDeleteService only guards `status = 'posted'`
        // and a migrated bill is approved/partially_paid/paid — so the money is
        // still in the payable control account. Letting the row be imported
        // again would carry that balance twice for one visible bill.
        const hasNumber = inv.invoiceNumber.trim() !== '';
        const already = hasNumber
          ? (await sql`
              SELECT id, deleted_at FROM supplier_invoices
              WHERE company_id = ${companyId}::UUID
                AND supplier_id = ${supplierId}::UUID
                AND LOWER(invoice_number) = LOWER(${inv.invoiceNumber})
              LIMIT 1
            `) as Row[]
          : (await sql`
              SELECT id, deleted_at FROM supplier_invoices
              WHERE company_id = ${companyId}::UUID
                AND supplier_id = ${supplierId}::UUID
                AND duplicate_fingerprint = ${migFingerprint}
              LIMIT 1
            `) as Row[];
        if (already.length > 0) {
          const wasDeleted = already[0]!.deleted_at != null;
          const subject = hasNumber
            ? `Already imported: ${inv.invoiceNumber} for this supplier.`
            : 'Already imported: a bill with no number and the same amount for this supplier.';
          errors.push({
            step: 'ap_invoices', row: fileRow(i), field: 'invoiceNumber',
            message: wasDeleted
              ? `${subject} It was deleted, but its take-on entry is still in the ledger — reverse that entry before bringing the bill back, or importing it again would count the balance twice.`
              : `${subject} Correcting an imported bill is an edit, not a re-import.`,
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
      errors.push({ step: 'ap_invoices', row: fileRow(i), message: msg });
      skipped++;
    }
  }

  // Warnings ride in the same column as errors, marked — see the AR step.
  await updateSession(sessionId, companyId, {
    apInvoicesImported: imported,
    stepsCompleted: { ap_invoices: true },
    errors: [...errors, ...warnings.map(w => ({ ...w, severity: 'warning' as const }))],
  });
  log.info('AP invoices imported', { companyId, imported, skipped }, 'migration');
  return { imported, skipped, errors, warnings };
}
