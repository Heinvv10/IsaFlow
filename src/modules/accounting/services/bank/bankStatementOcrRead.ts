/**
 * The read side of an AI-read statement import (bank_statement_imports): its shape, getImport, and the refusal for
 * one that is not ready to commit or roll back. Its own module so bankStatementOcrService and bankStatementOcrCommit
 * both import it without importing each other (review round 2).
 */

import { sql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { effectiveExtractionState } from './statementExtractionState';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface BankStatementRow {
  date: string;
  description: string;
  reference: string | null;
  amount: number;
  runningBalance: number | null;
  isDuplicate: boolean;
  duplicateOfBankTxId: string | null;
  duplicateMatchConfidence: number;
}

export interface BankStatementImport {
  id: string;
  companyId: string;
  bankAccountId: string;
  sourceDocumentId: string;
  periodStart: string | null;
  periodEnd: string | null;
  openingBalance: number | null;
  closingBalance: number | null;
  rowCount: number;
  importedCount: number;
  duplicateCount: number;
  status: 'extracting' | 'extracted' | 'reviewing' | 'committed' | 'rolled_back' | 'failed';
  /** Why the read failed (status 'failed'). */
  extractionError: string | null;
  /** A failed read can be tried again, except a statement with too many pages. */
  retryable: boolean;
  /** Pages read so far and in all, while 'extracting' a PDF. */
  pagesDone: number | null;
  pagesTotal: number | null;
  rows: BankStatementRow[];
  warnings: string[];
  createdAt: string;
  committedAt: string | null;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

export type DbRow = Record<string, unknown>;

function toDateStr(val: unknown): string | null {
  if (!val) return null;
  return fmtDate(val);
}

export function mapDbRow(row: DbRow): BankStatementImport {
  const summary = (row.extraction_summary ?? {}) as { rows?: BankStatementRow[]; warnings?: string[] };
  const state = effectiveExtractionState({
    status: row.status, created_at: row.created_at, extraction_heartbeat_at: row.extraction_heartbeat_at,
    extraction_error: row.extraction_error, extraction_error_code: row.extraction_error_code,
    extraction_pages_done: row.extraction_pages_done, extraction_pages_total: row.extraction_pages_total,
  });
  return {
    id: row.id as string,
    companyId: row.company_id as string,
    bankAccountId: row.bank_account_id as string,
    sourceDocumentId: row.source_document_id as string,
    periodStart: toDateStr(row.period_start),
    periodEnd: toDateStr(row.period_end),
    openingBalance: row.opening_balance != null ? Number(row.opening_balance) : null,
    closingBalance: row.closing_balance != null ? Number(row.closing_balance) : null,
    rowCount: Number(row.row_count ?? 0),
    importedCount: Number(row.imported_count ?? 0),
    duplicateCount: Number(row.duplicate_count ?? 0),
    status: state.status as BankStatementImport['status'],
    extractionError: state.extractionError,
    retryable: state.retryable,
    pagesDone: state.pagesDone,
    pagesTotal: state.pagesTotal,
    rows: summary.rows ?? [],
    warnings: summary.warnings ?? [],
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    committedAt: row.committed_at
      ? (row.committed_at instanceof Date ? row.committed_at.toISOString() : String(row.committed_at))
      : null,
  };
}

/** Commit or rollback of an import that is still being read, or failed to be. Thrown before any write, so the route may answer 409. */
export class ImportNotReadyError extends Error {
  readonly code = 'IMPORT_NOT_READY';
  constructor(message: string) {
    super(message);
    this.name = 'ImportNotReadyError';
  }
}

/** Why an import that is not 'extracted' yet cannot be committed or rolled back. */
export function notReadyError(status: BankStatementImport['status']): Error | null {
  if (status === 'extracting') return new ImportNotReadyError('Import is still being read');
  if (status === 'failed') return new ImportNotReadyError('Import could not be read');
  return null;
}

export async function getImport(companyId: string, importId: string): Promise<BankStatementImport | null> {
  const rows = (await sql`
    SELECT * FROM bank_statement_imports
    WHERE id = ${importId}::uuid AND company_id = ${companyId}
    LIMIT 1
  `) as DbRow[];
  return rows[0] ? mapDbRow(rows[0]) : null;
}
