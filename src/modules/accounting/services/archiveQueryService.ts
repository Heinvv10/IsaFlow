/**
 * Archive Query Service
 * Read-only queries: storage stats, preview, validation, run history, archived entries.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

const COMPONENT = 'data-archiving';
const MIN_RETENTION_YEARS = 5;

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

export function toISODate(val: Date | string | null): string | null {
  if (!val) return null;
  if (val instanceof Date) return val.toISOString().split('T')[0] ?? null;
  return String(val).split('T')[0] ?? null;
}

export function toStr(val: Date | string | null | undefined): string {
  if (!val) return '';
  if (val instanceof Date) return val.toISOString();
  return String(val);
}

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

export async function validateArchive(companyId: string, cutoffDate: string): Promise<ArchiveValidation> {
  const errors: string[] = [];

  try {
    const minCutoff = new Date();
    minCutoff.setFullYear(minCutoff.getFullYear() - MIN_RETENTION_YEARS);
    const cutoff = new Date(cutoffDate);
    if (cutoff >= minCutoff) {
      errors.push(
        `Cutoff date must be at least ${MIN_RETENTION_YEARS} years ago (before ${minCutoff.toISOString().split('T')[0]}). ` +
        `This is required by the SA Companies Act minimum retention period.`
      );
    }

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

