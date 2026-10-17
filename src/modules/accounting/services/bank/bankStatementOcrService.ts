/**
 * Bank Statement OCR Service — PRD-05 Phase 7
 *
 * Upload → an 'extracting' bank_statement_imports row answered at once → a background job reads the
 * statement (bankStatementExtractionJob) → the user reviews the rows → commit inserts the
 * non-duplicate ones into bank_transactions. A row that is 'extracting' or 'failed' has no rows to
 * commit or roll back; it can be retried or (failed only) deleted.
 */

import { sql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { log } from '@/lib/logger';
import { runAfterCommit } from '@/lib/afterCommit';
import { parsedDayWindowError } from '../../utils/journalDateWindow';
import { runBankStatementExtraction } from './bankStatementExtractionJob';
import {
  effectiveExtractionState, explainRefusal, STALE_AFTER_MINUTES,
} from './statementExtractionState';

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

type DbRow = Record<string, unknown>;

function toDateStr(val: unknown): string | null {
  if (!val) return null;
  return fmtDate(val);
}

function mapDbRow(row: DbRow): BankStatementImport {
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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Insert the import as 'extracting' and answer with it; the statement is read after the request commits
 * (a dense page takes the VLM ~55 s, longer than the request may run).
 */
export async function createImportFromDocument(
  companyId: string,
  bankAccountId: string,
  capturedDocumentId: string,
  userId: string,
): Promise<BankStatementImport> {
  const inserted = (await sql`
    INSERT INTO bank_statement_imports (
      company_id, bank_account_id, source_document_id,
      row_count, imported_count, duplicate_count,
      status, extraction_summary, created_by
    ) VALUES (
      ${companyId}, ${bankAccountId}::uuid, ${capturedDocumentId}::uuid,
      0, 0, 0, 'extracting', '{}'::jsonb, ${userId}::uuid
    )
    RETURNING *
  `) as DbRow[];

  const result = mapDbRow(inserted[0]!);
  runAfterCommit('bank statement extraction', () => runBankStatementExtraction(companyId, result.id));
  log.info('bankStatementOcr: import queued for extraction', { importId: result.id, capturedDocumentId }, 'bank-stmt-ocr');
  return result;
}

/**
 * Put a failed import (or one whose read was interrupted) back to 'extracting' and read it again.
 * One guarded UPDATE decides: a double click, or a statement that is too long, matches no row.
 */
export async function retryImport(companyId: string, importId: string): Promise<BankStatementImport> {
  const updated = (await sql`
    UPDATE bank_statement_imports
    SET status = 'extracting', extraction_error = NULL, extraction_error_code = NULL,
        extraction_heartbeat_at = NOW(), extraction_pages_done = NULL, extraction_pages_total = NULL,
        updated_at = NOW()
    WHERE id = ${importId}::uuid AND company_id = ${companyId}
      AND extraction_error_code IS DISTINCT FROM 'too_many_pages'
      AND (status = 'failed'
        OR (status = 'extracting' AND COALESCE(extraction_heartbeat_at, created_at) < NOW() - make_interval(mins => ${STALE_AFTER_MINUTES})))
    RETURNING *
  `) as DbRow[];
  if (!updated[0]) throw explainRefusal('retry', await findRow(companyId, importId));

  runAfterCommit('bank statement extraction', () => runBankStatementExtraction(companyId, importId));
  log.info('bankStatementOcr: import queued for another extraction', { importId }, 'bank-stmt-ocr');
  return mapDbRow(updated[0]);
}

/** Delete an import that failed (or whose read was interrupted). The uploaded document is kept. */
export async function deleteFailedImport(companyId: string, importId: string): Promise<void> {
  const deleted = (await sql`
    DELETE FROM bank_statement_imports
    WHERE id = ${importId}::uuid AND company_id = ${companyId}
      AND (status = 'failed'
        OR (status = 'extracting' AND COALESCE(extraction_heartbeat_at, created_at) < NOW() - make_interval(mins => ${STALE_AFTER_MINUTES})))
    RETURNING id
  `) as DbRow[];
  if (!deleted[0]) throw explainRefusal('delete', await findRow(companyId, importId));
  log.info('bankStatementOcr: failed import deleted', { importId }, 'bank-stmt-ocr');
}

async function findRow(companyId: string, importId: string): Promise<DbRow | null> {
  const rows = (await sql`
    SELECT * FROM bank_statement_imports WHERE id = ${importId}::uuid AND company_id = ${companyId} LIMIT 1
  `) as DbRow[];
  return rows[0] ?? null;
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
function notReadyError(status: BankStatementImport['status']): Error | null {
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

export async function commitImport(
  companyId: string,
  importId: string,
  userId: string,
): Promise<{ inserted: number; skipped: number }> {
  // Locked first, so a concurrent commit waits here and then reads 'committed' — one batch row, one set of lines.
  await sql`SELECT 1 FROM bank_statement_imports WHERE id = ${importId}::uuid AND company_id = ${companyId} FOR UPDATE`;
  const imp = await getImport(companyId, importId);
  if (!imp) throw new Error(`Import not found: ${importId}`);
  const notReady = notReadyError(imp.status);
  if (notReady) throw notReady;
  if (imp.status === 'committed') throw new Error('Import already committed');
  if (imp.status === 'rolled_back') throw new Error('Import has been rolled back');

  const nonDupes = imp.rows.filter((r) => !r.isDuplicate && r.date && parsedDayWindowError(r.date) === null);
  log.info('bankStatementOcr: committing import', { importId, nonDupeCount: nonDupes.length }, 'bank-stmt-ocr');

  // Step 2 provenance: the batch the lines name (its id is this import's), recording as the importer the person who
  // UPLOADED the statement — whose file the lines are, and who may then not allocate them under enforcement (the
  // committer only confirms rows they cannot edit) — falling back to the committer, and the document's SHA-256.
  if (nonDupes.length > 0) {
    await sql`
      INSERT INTO bank_import_batches (id, company_id, bank_account_id, statement_date, transaction_count,
        source_filename, imported_by, import_channel, file_sha256)
      SELECT si.id, si.company_id, si.bank_account_id, COALESCE(si.period_end, ${nonDupes.map((r) => r.date).sort().at(-1)!}::DATE),
             ${nonDupes.length}, cd.file_name, COALESCE(si.created_by::TEXT, cd.uploaded_by::TEXT, ${userId}), 'statement_ocr',
             CASE WHEN cd.raw_bytes_sha256 ~ '^[0-9a-f]{64}$' THEN cd.raw_bytes_sha256 END
      FROM bank_statement_imports si
      LEFT JOIN captured_documents cd ON cd.id = si.source_document_id AND cd.company_id = si.company_id
      WHERE si.id = ${importId}::uuid AND si.company_id = ${companyId}::uuid
    `;
  }

  let insertedCount = 0;
  for (const row of nonDupes) {
    await sql`
      INSERT INTO bank_transactions (
        company_id, bank_account_id, transaction_date, amount,
        description, reference, status, import_batch_id
      ) VALUES (
        ${companyId}, ${imp.bankAccountId}::uuid, ${row.date}::date, ${row.amount},
        ${row.description}, ${row.reference ?? null}, 'imported', ${importId}::uuid
      )
      ON CONFLICT DO NOTHING
    `;
    insertedCount++;
  }

  const skipped = imp.rows.length - insertedCount;

  await sql`
    UPDATE bank_statement_imports
    SET status = 'committed',
        imported_count = ${insertedCount},
        committed_at = NOW(),
        committed_by = ${userId}::uuid,
        updated_at = NOW()
    WHERE id = ${importId}::uuid AND company_id = ${companyId}
  `;

  log.info('bankStatementOcr: import committed', { importId, insertedCount, skipped }, 'bank-stmt-ocr');
  return { inserted: insertedCount, skipped };
}

export async function rollbackImport(companyId: string, importId: string, userId: string): Promise<void> {
  const imp = await getImport(companyId, importId);
  if (!imp) throw new Error(`Import not found: ${importId}`);
  const notReady = notReadyError(imp.status);
  if (notReady) throw notReady;
  if (imp.status === 'committed') throw new Error('Cannot roll back a committed import');

  await sql`
    UPDATE bank_statement_imports
    SET status = 'rolled_back', updated_at = NOW()
    WHERE id = ${importId}::uuid AND company_id = ${companyId}
  `;

  log.info('bankStatementOcr: import rolled back', { importId, userId }, 'bank-stmt-ocr');
}

export async function listImports(companyId: string, limit = 50): Promise<BankStatementImport[]> {
  const rows = (await sql`
    SELECT * FROM bank_statement_imports
    WHERE company_id = ${companyId}
    ORDER BY created_at DESC
    LIMIT ${limit}
  `) as DbRow[];
  return rows.map(mapDbRow);
}
