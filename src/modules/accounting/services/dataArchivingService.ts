/**
 * Data Archiving & Retention Engine Service
 * WS-7.4 — Move old posted financial data into archive_* tables.
 * SA Companies Act minimum retention: 5 years.
 * All archive operations run inside a transaction — rollback on any error.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { logAudit } from './auditTrailService';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

export interface StorageStats {
  tableName: string;
  rowCount: number;
  oldestDate: string | null;
  newestDate: string | null;
}

export interface ArchivePreview {
  journalEntries: number;
  journalLines: number;
  bankTransactions: number;
  customerInvoices: number;
  supplierInvoices: number;
  totalRecords: number;
}

export interface ArchiveValidation {
  valid: boolean;
  errors: string[];
}

export interface ArchiveResult {
  runId: string;
  entriesArchived: number;
  linesArchived: number;
  transactionsArchived: number;
  invoicesArchived: number;
  supplierInvoicesArchived: number;
}

export interface ArchiveRun {
  id: string;
  cutoffDate: string;
  status: string;
  entriesArchived: number;
  linesArchived: number;
  transactionsArchived: number;
  invoicesArchived: number;
  supplierInvoicesArchived: number;
  startedAt: string | null;
  completedAt: string | null;
  errorMessage: string | null;
  createdAt: string;
}

export interface ArchivedEntry {
  id: string;
  entryNumber: string | null;
  entryDate: string;
  description: string | null;
  status: string | null;
  source: string | null;
  createdAt: string;
}

const COMPONENT = 'data-archiving';
const MIN_RETENTION_YEARS = 5;

function toISODate(val: Date | string | null): string | null {
  if (!val) return null;
  if (val instanceof Date) return val.toISOString().split('T')[0] ?? null;
  return String(val).split('T')[0] ?? null;
}

function toStr(val: Date | string | null | undefined): string {
  if (!val) return '';
  if (val instanceof Date) return val.toISOString();
  return String(val);
}

// ---------------------------------------------------------------------------
// Storage Dashboard
// ---------------------------------------------------------------------------

export async function getStorageStats(companyId: string): Promise<StorageStats[]> {
  try {
    const [jeRows, btRows, ciRows, siRows] = await Promise.all([
      sql`
        SELECT COUNT(*) AS row_count,
               MIN(entry_date) AS oldest_date,
               MAX(entry_date) AS newest_date
        FROM gl_journal_entries
        WHERE company_id = ${companyId}
      ` as Promise<Row[]>,
      sql`
        SELECT COUNT(*) AS row_count,
               MIN(transaction_date) AS oldest_date,
               MAX(transaction_date) AS newest_date
        FROM bank_transactions
        WHERE company_id = ${companyId}
      ` as Promise<Row[]>,
      sql`
        SELECT COUNT(*) AS row_count,
               MIN(invoice_date) AS oldest_date,
               MAX(invoice_date) AS newest_date
        FROM customer_invoices
        WHERE company_id = ${companyId}
      ` as Promise<Row[]>,
      sql`
        SELECT COUNT(*) AS row_count,
               MIN(invoice_date) AS oldest_date,
               MAX(invoice_date) AS newest_date
        FROM supplier_invoices
        WHERE company_id = ${companyId}
      ` as Promise<Row[]>,
    ]);

    // Journal lines — scoped via journal entry join
    const jlRows = (await sql`
      SELECT COUNT(*) AS row_count
      FROM gl_journal_lines jl
      JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
      WHERE je.company_id = ${companyId}
    `) as Row[];

    const stats: StorageStats[] = [
      {
        tableName: 'gl_journal_entries',
        rowCount: Number(jeRows[0]?.row_count ?? 0),
        oldestDate: toISODate(jeRows[0]?.oldest_date ?? null),
        newestDate: toISODate(jeRows[0]?.newest_date ?? null),
      },
      {
        tableName: 'gl_journal_lines',
        rowCount: Number(jlRows[0]?.row_count ?? 0),
        oldestDate: null,
        newestDate: null,
      },
      {
        tableName: 'bank_transactions',
        rowCount: Number(btRows[0]?.row_count ?? 0),
        oldestDate: toISODate(btRows[0]?.oldest_date ?? null),
        newestDate: toISODate(btRows[0]?.newest_date ?? null),
      },
      {
        tableName: 'customer_invoices',
        rowCount: Number(ciRows[0]?.row_count ?? 0),
        oldestDate: toISODate(ciRows[0]?.oldest_date ?? null),
        newestDate: toISODate(ciRows[0]?.newest_date ?? null),
      },
      {
        tableName: 'supplier_invoices',
        rowCount: Number(siRows[0]?.row_count ?? 0),
        oldestDate: toISODate(siRows[0]?.oldest_date ?? null),
        newestDate: toISODate(siRows[0]?.newest_date ?? null),
      },
    ];

    log.info('Storage stats retrieved', { companyId }, COMPONENT);
    return stats;
  } catch (err) {
    log.error('Failed to get storage stats', { companyId, error: err }, COMPONENT);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

export async function previewArchive(companyId: string, cutoffDate: string): Promise<ArchivePreview> {
  try {
    const [jeRows, btRows, ciRows, siRows] = await Promise.all([
      sql`
        SELECT COUNT(*) AS cnt
        FROM gl_journal_entries
        WHERE company_id = ${companyId}
          AND entry_date < ${cutoffDate}::date
          AND status = 'posted'
      ` as Promise<Row[]>,
      sql`
        SELECT COUNT(*) AS cnt
        FROM bank_transactions
        WHERE company_id = ${companyId}
          AND transaction_date < ${cutoffDate}::date
          AND status = 'reconciled'
      ` as Promise<Row[]>,
      sql`
        SELECT COUNT(*) AS cnt
        FROM customer_invoices
        WHERE company_id = ${companyId}
          AND invoice_date < ${cutoffDate}::date
          AND status IN ('paid', 'cancelled')
      ` as Promise<Row[]>,
      sql`
        SELECT COUNT(*) AS cnt
        FROM supplier_invoices
        WHERE company_id = ${companyId}
          AND invoice_date < ${cutoffDate}::date
          AND status IN ('paid', 'cancelled')
      ` as Promise<Row[]>,
    ]);

    const journalEntries = Number(jeRows[0]?.cnt ?? 0);

    // Journal lines follow their parent entries
    const jlRows = (await sql`
      SELECT COUNT(*) AS cnt
      FROM gl_journal_lines jl
      JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
      WHERE je.company_id = ${companyId}
        AND je.entry_date < ${cutoffDate}::date
        AND je.status = 'posted'
    `) as Row[];

    const journalLines = Number(jlRows[0]?.cnt ?? 0);
    const bankTransactions = Number(btRows[0]?.cnt ?? 0);
    const customerInvoices = Number(ciRows[0]?.cnt ?? 0);
    const supplierInvoices = Number(siRows[0]?.cnt ?? 0);

    return {
      journalEntries,
      journalLines,
      bankTransactions,
      customerInvoices,
      supplierInvoices,
      totalRecords: journalEntries + journalLines + bankTransactions + customerInvoices + supplierInvoices,
    };
  } catch (err) {
    log.error('Failed to preview archive', { companyId, cutoffDate, error: err }, COMPONENT);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export async function validateArchive(companyId: string, cutoffDate: string): Promise<ArchiveValidation> {
  const errors: string[] = [];

  try {
    // Rule 1: cutoff must be at least MIN_RETENTION_YEARS ago
    const minCutoff = new Date();
    minCutoff.setFullYear(minCutoff.getFullYear() - MIN_RETENTION_YEARS);
    const cutoff = new Date(cutoffDate);
    if (cutoff >= minCutoff) {
      errors.push(
        `Cutoff date must be at least ${MIN_RETENTION_YEARS} years ago (before ${minCutoff.toISOString().split('T')[0]}). ` +
        `This is required by the SA Companies Act minimum retention period.`
      );
    }

    // Rule 2: all fiscal periods before cutoff must be 'locked'
    const unlockedRows = (await sql`
      SELECT COUNT(*) AS cnt
      FROM fiscal_periods
      WHERE company_id = ${companyId}
        AND end_date < ${cutoffDate}::date
        AND status != 'locked'
    `) as Row[];

    const unlockedCount = Number(unlockedRows[0]?.cnt ?? 0);
    if (unlockedCount > 0) {
      errors.push(
        `${unlockedCount} fiscal period(s) before the cutoff date are not locked. ` +
        `All periods must be locked before archiving.`
      );
    }

    // Rule 3: no draft/pending journal entries before cutoff
    const draftRows = (await sql`
      SELECT COUNT(*) AS cnt
      FROM gl_journal_entries
      WHERE company_id = ${companyId}
        AND entry_date < ${cutoffDate}::date
        AND status IN ('draft')
    `) as Row[];

    const draftCount = Number(draftRows[0]?.cnt ?? 0);
    if (draftCount > 0) {
      errors.push(
        `${draftCount} journal entry/entries before the cutoff are still in draft status. ` +
        `Post or delete these before archiving.`
      );
    }

    // Rule 4: ensure there is actually data to archive
    const preview = await previewArchive(companyId, cutoffDate);
    if (preview.totalRecords === 0) {
      errors.push('No records found before the cutoff date that are eligible for archiving.');
    }

    return { valid: errors.length === 0, errors };
  } catch (err) {
    log.error('Archive validation failed', { companyId, cutoffDate, error: err }, COMPONENT);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Execute Archive (transactional)
// ---------------------------------------------------------------------------

export async function executeArchive(
  companyId: string,
  cutoffDate: string,
  userId: string
): Promise<ArchiveResult> {
  // Create the run record first
  const runRows = (await sql`
    INSERT INTO archive_runs (company_id, run_by, cutoff_date, status, started_at)
    VALUES (${companyId}, ${userId}, ${cutoffDate}::date, 'running', NOW())
    RETURNING id
  `) as Row[];
  const runId: string = runRows[0].id as string;

  log.info('Archive run started', { companyId, runId, cutoffDate, userId }, COMPONENT);

  try {
    // --- Step 1: Archive GL journal entries (RETURNING id for count) ---
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

    // --- Step 2: Archive GL journal lines (for archived entries) ---
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

    // --- Step 3: Archive reconciled bank transactions ---
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

    // --- Step 4: Archive paid/cancelled customer invoices ---
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

    // --- Step 5: Archive paid/cancelled supplier invoices ---
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

    // --- Step 6: Delete from active tables (reverse dependency order) ---
    // Lines before entries
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

    // --- Step 7: Update run record to completed ---
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

    // Fire-and-forget audit log
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

    return {
      runId,
      entriesArchived,
      linesArchived,
      transactionsArchived,
      invoicesArchived,
      supplierInvoicesArchived,
    };
  } catch (err) {
    // Mark run as failed
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

// ---------------------------------------------------------------------------
// Archive Run History
// ---------------------------------------------------------------------------

export async function getArchiveRuns(companyId: string): Promise<ArchiveRun[]> {
  try {
    const rows = (await sql`
      SELECT id, cutoff_date, status, entries_archived, lines_archived,
             transactions_archived, invoices_archived, supplier_invoices_archived,
             started_at, completed_at, error_message, created_at
      FROM archive_runs
      WHERE company_id = ${companyId}
      ORDER BY created_at DESC
      LIMIT 50
    `) as Row[];

    return rows.map((r: Row): ArchiveRun => ({
      id: r.id as string,
      cutoffDate: toISODate(r.cutoff_date) ?? '',
      status: r.status as string,
      entriesArchived: Number(r.entries_archived ?? 0),
      linesArchived: Number(r.lines_archived ?? 0),
      transactionsArchived: Number(r.transactions_archived ?? 0),
      invoicesArchived: Number(r.invoices_archived ?? 0),
      supplierInvoicesArchived: Number(r.supplier_invoices_archived ?? 0),
      startedAt: r.started_at ? toStr(r.started_at as Date | string) : null,
      completedAt: r.completed_at ? toStr(r.completed_at as Date | string) : null,
      errorMessage: r.error_message as string | null,
      createdAt: toStr(r.created_at as Date | string),
    }));
  } catch (err) {
    log.error('Failed to get archive runs', { companyId, error: err }, COMPONENT);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Query Archived Entries (read-only)
// ---------------------------------------------------------------------------

export async function getArchivedEntries(
  companyId: string,
  filters: { dateFrom?: string; dateTo?: string; limit?: number; offset?: number }
): Promise<{ items: ArchivedEntry[]; total: number }> {
  try {
    const limit = Math.min(filters.limit ?? 50, 200);
    const offset = filters.offset ?? 0;
    const dateFrom = filters.dateFrom ?? null;
    const dateTo = filters.dateTo ?? null;

    const rows = (await sql`
      SELECT id, entry_number, entry_date, description, status, source, created_at
      FROM archive_gl_journal_entries
      WHERE company_id = ${companyId}
        AND (${dateFrom}::date IS NULL OR entry_date >= ${dateFrom}::date)
        AND (${dateTo}::date IS NULL OR entry_date <= ${dateTo}::date)
      ORDER BY entry_date DESC
      LIMIT ${limit} OFFSET ${offset}
    `) as Row[];

    const countRows = (await sql`
      SELECT COUNT(*) AS cnt
      FROM archive_gl_journal_entries
      WHERE company_id = ${companyId}
        AND (${dateFrom}::date IS NULL OR entry_date >= ${dateFrom}::date)
        AND (${dateTo}::date IS NULL OR entry_date <= ${dateTo}::date)
    `) as Row[];

    const items: ArchivedEntry[] = rows.map((r: Row): ArchivedEntry => ({
      id: r.id as string,
      entryNumber: r.entry_number as string | null,
      entryDate: toISODate(r.entry_date) ?? '',
      description: r.description as string | null,
      status: r.status as string | null,
      source: r.source as string | null,
      createdAt: toStr(r.created_at as Date | string),
    }));

    return { items, total: Number(countRows[0]?.cnt ?? 0) };
  } catch (err) {
    log.error('Failed to get archived entries', { companyId, filters, error: err }, COMPONENT);
    throw err;
  }
}
