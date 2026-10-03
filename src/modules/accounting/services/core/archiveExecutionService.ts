/**
 * Archive Execution Service
 * Executes the archive run — moves old records to archive tables and deletes originals.
 * SA Companies Act minimum retention: 5 years.
 */

import { sql, withSavepoint } from '@/lib/neon';
import { log } from '@/lib/logger';
import { logAuditOrThrow } from './auditTrailService';
import {
  ArchiveSkippedInvoiceJournalError, countSkippedInvoiceJournalsInWindow, moveCustomerInvoicesToArchive,
  movedJournal, selectArchivableCustomerInvoices, skippedInvoiceJournalMessage,
} from './archiveCustomerInvoiceScope';
import type { DbRow } from '@/types/db';


const COMPONENT = 'data-archiving';

export interface ArchiveResult {
  runId: string;
  entriesArchived: number;
  linesArchived: number;
  transactionsArchived: number;
  invoicesArchived: number;
  /** Paid/cancelled pre-cutoff invoices kept live because a Paystack or Stitch request references them (R-186). */
  invoicesSkipped: number;
  supplierInvoicesArchived: number;
}

export async function executeArchive(
  companyId: string,
  cutoffDate: string,
  userId: string
): Promise<ArchiveResult> {
  const runRows = (await sql`
    INSERT INTO archive_runs (company_id, run_by, cutoff_date, status, started_at)
    VALUES (${companyId}, ${userId}, ${cutoffDate}::date, 'running', NOW())
    RETURNING id
  `) as DbRow[];
  const runId: string = runRows[0]!.id as string;

  log.info('Archive run started', { companyId, runId, cutoffDate, userId }, COMPONENT);

  // The archive body runs inside a savepoint on the caller's withAuth
  // request transaction. Without it, a failed step leaves that shared tx
  // aborted: the failure-mark UPDATE in the catch below would itself throw
  // ("current transaction is aborted"), masking the original error, and the
  // 'failed' run record could never persist. Rolling back to the savepoint
  // un-aborts the tx so the mark commits with the request; the run-record
  // INSERT above sits OUTSIDE the savepoint so it survives the rollback.
  try {
    return await withSavepoint('archive_body', async (): Promise<ArchiveResult> => {
    // Step 0 (was step 4; R-186 round 3), before anything is copied: choose the
    // paid/cancelled customer invoices to archive (ones a Paystack or Stitch
    // request references are skipped) and refuse if a skipped one still points
    // into the journals the run moves.
    // Reads only, no FOR UPDATE, so the lock order of step 6 is unchanged; step 6
    // moves the invoices in one statement and re-checks both predicates.
    const ciScope = await selectArchivableCustomerInvoices(companyId, cutoffDate);
    const invoicesSkipped = ciScope.skippedIds.length;
    const keptJournals = await countSkippedInvoiceJournalsInWindow(companyId, cutoffDate, ciScope.skippedIds);
    if (keptJournals > 0) throw new ArchiveSkippedInvoiceJournalError(skippedInvoiceJournalMessage(keptJournals));

    // Step 1: Archive GL journal entries
    const jeRows = (await sql`
      INSERT INTO archive_gl_journal_entries
        (id, entry_number, entry_date, fiscal_period_id, description, source,
         source_document_id, status, posted_by, posted_at, reversed_by, reversed_at,
         reversal_of_id, created_by, created_at, updated_at, reference,
         project_id, cost_center_id, company_id)
      SELECT id, entry_number, entry_date, fiscal_period_id, description, source,
             source_document_id, status, posted_by, posted_at, reversed_by, reversed_at,
             reversal_of_id, created_by, created_at, updated_at, reference,
             project_id, cost_center_id, company_id
      FROM gl_journal_entries je
      WHERE ${movedJournal(companyId, cutoffDate)}
      ON CONFLICT (id) DO NOTHING
      RETURNING id
    `) as DbRow[];
    const entriesArchived = jeRows.length;

    // Step 2: Archive GL journal lines
    const jlRows = (await sql`
      INSERT INTO archive_gl_journal_lines
        (id, journal_entry_id, gl_account_id, debit, credit, description,
         project_id, cost_center_id, created_at)
      SELECT jl.id, jl.journal_entry_id, jl.gl_account_id, jl.debit, jl.credit,
             jl.description, jl.project_id, jl.cost_center_id, jl.created_at
      FROM gl_journal_lines jl
      JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
      WHERE ${movedJournal(companyId, cutoffDate)}
        AND jl.company_id = ${companyId}::UUID
      ON CONFLICT (id) DO NOTHING
      RETURNING id
    `) as DbRow[];
    const linesArchived = jlRows.length;

    // Step 3: Archive reconciled bank transactions
    const btRows = (await sql`
      INSERT INTO archive_bank_transactions
        (id, bank_account_id, transaction_date, value_date, amount, description,
         reference, bank_reference, status, matched_journal_line_id, reconciliation_id,
         import_batch_id, excluded_reason, notes, created_at, updated_at, company_id)
      SELECT id, bank_account_id, transaction_date, value_date, amount, description,
             reference, bank_reference, status, matched_journal_line_id, reconciliation_id,
             import_batch_id, excluded_reason, notes, created_at, updated_at, company_id
      FROM bank_transactions
      WHERE company_id = ${companyId}
        AND transaction_date < ${cutoffDate}::date
        AND status = 'reconciled'
      ON CONFLICT (id) DO NOTHING
      RETURNING id
    `) as DbRow[];
    const transactionsArchived = btRows.length;

    // Step 5: Archive paid/cancelled supplier invoices
    const siRows = (await sql`
      INSERT INTO archive_supplier_invoices
        (id, invoice_number, supplier_id, purchase_order_id, grn_id,
         invoice_date, due_date, received_date, subtotal, tax_rate, tax_amount,
         total_amount, amount_paid, payment_terms, currency, reference,
         status, match_status, project_id, cost_center_id, gl_journal_entry_id,
         sage_invoice_id, notes, created_by, approved_by, approved_at,
         created_at, updated_at, company_id)
      SELECT id, invoice_number, supplier_id, purchase_order_id, grn_id,
             invoice_date, due_date, received_date, subtotal, tax_rate, tax_amount,
             total_amount, amount_paid, payment_terms, currency, reference,
             status, match_status, project_id, cost_center_id, gl_journal_entry_id,
             sage_invoice_id, notes, created_by, approved_by, approved_at,
             created_at, updated_at, company_id
      FROM supplier_invoices
      WHERE company_id = ${companyId}
        AND invoice_date < ${cutoffDate}::date
        AND status IN ('paid', 'cancelled')
      ON CONFLICT (id) DO NOTHING
      RETURNING id
    `) as DbRow[];
    const supplierInvoicesArchived = siRows.length;

    // Step 6: Delete from active tables — (1) bank, (3) invoices, (4) GL lines
    // then GL entries. That is the canonical lock order of
    // `src/modules/accounting/services/bank/.claude.md`, and it is ALSO the
    // FK dependency order, which is why the previous sequence (GL lines, GL
    // entries, bank, invoices) was not merely a lock inversion: measured on the
    // fixture, deleting a `gl_journal_lines` row still referenced by a
    // reconciled `bank_transactions.matched_journal_line_id` (NO ACTION) raises
    // `bank_transactions_matched_journal_line_id_fkey` — exactly the pair this
    // step exists to archive. Children before parents in both directions.
    await sql`
      DELETE FROM bank_transactions
      WHERE company_id = ${companyId}
        AND transaction_date < ${cutoffDate}::date
        AND status = 'reconciled'
    `;

    const invoicesArchived = await moveCustomerInvoicesToArchive(companyId, cutoffDate, ciScope.ids);
    // Second kept-journal check, just before the GL deletes: a skipped invoice
    // linked (or a chain journal posted) since step 0 must not escape. The
    // throw rolls the copies above back with the savepoint.
    const keptJournalsNow = await countSkippedInvoiceJournalsInWindow(companyId, cutoffDate, ciScope.skippedIds);
    if (keptJournalsNow > 0) throw new ArchiveSkippedInvoiceJournalError(skippedInvoiceJournalMessage(keptJournalsNow));

    await sql`
      DELETE FROM supplier_invoices
      WHERE company_id = ${companyId}
        AND invoice_date < ${cutoffDate}::date
        AND status IN ('paid', 'cancelled')
    `;

    // jl.company_id guard provides defense-in-depth alongside the subquery scope (BL-13)
    await sql`
      DELETE FROM gl_journal_lines jl
      WHERE jl.company_id = ${companyId}::UUID
        AND jl.journal_entry_id IN (
          SELECT je.id FROM gl_journal_entries je
          WHERE ${movedJournal(companyId, cutoffDate)}
        )
    `;

    await sql`
      DELETE FROM gl_journal_entries je
      WHERE ${movedJournal(companyId, cutoffDate)}
    `;

    // Step 7: Update run record to completed
    await sql`
      UPDATE archive_runs
      SET status = 'completed',
          completed_at = NOW(),
          entries_archived = ${entriesArchived},
          lines_archived = ${linesArchived},
          transactions_archived = ${transactionsArchived},
          invoices_archived = ${invoicesArchived},
          supplier_invoices_archived = ${supplierInvoicesArchived}
      WHERE id = ${runId}
    `;

    // Fatal by design: nothing above (moved rows, the completed UPDATE) is
    // durable until the request tx commits. Swallowing this error would
    // return 200 "success" for an archive that the savepoint rollback then
    // erases. Letting it throw rolls the archive back to the savepoint and
    // marks the run failed — response stays consistent with the DB state.
    await logAuditOrThrow({
      companyId,
      userId,
      action: 'export',
      entityType: 'archive_run',
      entityId: runId,
      entityRef: `Archive before ${cutoffDate}`,
      changes: {
        fields: [],
        metadata: {
          cutoffDate,
          entriesArchived: String(entriesArchived),
          linesArchived: String(linesArchived),
          transactionsArchived: String(transactionsArchived),
          invoicesArchived: String(invoicesArchived),
          invoicesSkipped: String(invoicesSkipped),
          supplierInvoicesArchived: String(supplierInvoicesArchived),
        },
      },
    });

    log.info('Archive run completed', {
      companyId, runId, entriesArchived, linesArchived,
      transactionsArchived, invoicesArchived, invoicesSkipped, supplierInvoicesArchived,
    }, COMPONENT);

    return {
      runId, entriesArchived, linesArchived, transactionsArchived,
      invoicesArchived, invoicesSkipped, supplierInvoicesArchived,
    };
    });
  } catch (err) {
    // Own savepoint + logged catch: if even the failure mark cannot be
    // written, the original error must still be the one that propagates.
    await withSavepoint('archive_mark_failed', async () => {
      await sql`
        UPDATE archive_runs
        SET status = 'failed',
            completed_at = NOW(),
            error_message = ${String(err)}
        WHERE id = ${runId}
      `;
    }).catch((markErr: unknown) => {
      log.error('Failed to record archive failure', { companyId, runId, markErr: String(markErr) }, COMPONENT);
    });
    log.error('Archive run failed', { companyId, runId, error: err }, COMPONENT);
    throw err;
  }
}
