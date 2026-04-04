/**
 * Archive Execution Service
 * Executes the archive run — moves old records to archive tables and deletes originals.
 * SA Companies Act minimum retention: 5 years.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { logAudit } from './auditTrailService';

type Row = Record<string, unknown>;

const COMPONENT = 'data-archiving';

export interface ArchiveResult {
  runId: string;
  entriesArchived: number;
  linesArchived: number;
  transactionsArchived: number;
  invoicesArchived: number;
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
  `) as Row[];
  const runId: string = runRows[0]!.id as string;

  log.info('Archive run started', { companyId, runId, cutoffDate, userId }, COMPONENT);

  try {
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
      FROM gl_journal_entries
      WHERE company_id = ${companyId}
        AND entry_date < ${cutoffDate}::date
        AND status = 'posted'
      ON CONFLICT (id) DO NOTHING
      RETURNING id
    `) as Row[];
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
      WHERE je.company_id = ${companyId}
        AND je.entry_date < ${cutoffDate}::date
        AND je.status = 'posted'
      ON CONFLICT (id) DO NOTHING
      RETURNING id
    `) as Row[];
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
    `) as Row[];
    const transactionsArchived = btRows.length;

    // Step 4: Archive paid/cancelled customer invoices
    const ciRows = (await sql`
      INSERT INTO archive_customer_invoices
        (id, invoice_number, customer_id, client_id, billing_period_start, billing_period_end,
         subtotal, tax_rate, tax_amount, total_amount, amount_paid, status,
         invoice_date, due_date, sent_at, paid_at, notes, internal_notes,
         project_id, gl_journal_entry_id, created_by, approved_by, approved_at,
         currency, created_at, updated_at, company_id)
      SELECT id, invoice_number, customer_id, client_id, billing_period_start, billing_period_end,
             subtotal, tax_rate, tax_amount, total_amount, amount_paid, status,
             invoice_date, due_date, sent_at, paid_at, notes, internal_notes,
             project_id, gl_journal_entry_id, created_by, approved_by, approved_at,
             currency, created_at, updated_at, company_id
      FROM customer_invoices
      WHERE company_id = ${companyId}
        AND invoice_date < ${cutoffDate}::date
        AND status IN ('paid', 'cancelled')
      ON CONFLICT (id) DO NOTHING
      RETURNING id
    `) as Row[];
    const invoicesArchived = ciRows.length;

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
    `) as Row[];
    const supplierInvoicesArchived = siRows.length;

    // Step 6: Delete from active tables (reverse dependency order)
    await sql`
      DELETE FROM gl_journal_lines
      WHERE journal_entry_id IN (
        SELECT id FROM gl_journal_entries
        WHERE company_id = ${companyId}
          AND entry_date < ${cutoffDate}::date
          AND status = 'posted'
      )
    `;

    await sql`
      DELETE FROM gl_journal_entries
      WHERE company_id = ${companyId}
        AND entry_date < ${cutoffDate}::date
        AND status = 'posted'
    `;

    await sql`
      DELETE FROM bank_transactions
      WHERE company_id = ${companyId}
        AND transaction_date < ${cutoffDate}::date
        AND status = 'reconciled'
    `;

    await sql`
      DELETE FROM customer_invoices
      WHERE company_id = ${companyId}
        AND invoice_date < ${cutoffDate}::date
        AND status IN ('paid', 'cancelled')
    `;

    await sql`
      DELETE FROM supplier_invoices
      WHERE company_id = ${companyId}
        AND invoice_date < ${cutoffDate}::date
        AND status IN ('paid', 'cancelled')
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

    logAudit({
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
          supplierInvoicesArchived: String(supplierInvoicesArchived),
        },
      },
    }).catch(() => undefined);

    log.info('Archive run completed', {
      companyId, runId, entriesArchived, linesArchived,
      transactionsArchived, invoicesArchived, supplierInvoicesArchived,
    }, COMPONENT);

    return { runId, entriesArchived, linesArchived, transactionsArchived, invoicesArchived, supplierInvoicesArchived };
  } catch (err) {
    await sql`
      UPDATE archive_runs
      SET status = 'failed',
          completed_at = NOW(),
          error_message = ${String(err)}
      WHERE id = ${runId}
    `;
    log.error('Archive run failed', { companyId, runId, error: err }, COMPONENT);
    throw err;
  }
}
