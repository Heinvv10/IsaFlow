/**
 * Bank Statement OCR Service — PRD-05 Phase 7
 *
 * Upload → an 'extracting' bank_statement_imports row answered at once → a background job reads the
 * statement (bankStatementExtractionJob) → the user reviews the rows → commit inserts the
 * non-duplicate ones into bank_transactions. A row that is 'extracting' or 'failed' has no rows to
 * commit or roll back; it can be retried or (failed only) deleted.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { runAfterCommit } from '@/lib/afterCommit';
import { runBankStatementExtraction } from './bankStatementExtractionJob';
import { ExtractionActionRefusedError, explainRefusal, STALE_AFTER_MINUTES } from './statementExtractionState';

import { getImport, mapDbRow, notReadyError, type BankStatementImport, type DbRow } from './bankStatementOcrRead';

// The read side and commit live in their own files (bankStatementOcrRead: the row shape, getImport, the not-ready
// refusal; bankStatementOcrCommit: the batch row and its lines); re-exported so callers keep this import path.
export { commitImport } from './bankStatementOcrCommit';
export { getImport, ImportNotReadyError } from './bankStatementOcrRead';
export type { BankStatementImport, BankStatementRow } from './bankStatementOcrRead';

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
    SET status = 'extracting', extraction_attempt = extraction_attempt + 1, extraction_error = NULL, extraction_error_code = NULL,
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

export async function rollbackImport(companyId: string, importId: string, userId: string): Promise<void> {
  // Locked first, as commit does: a commit in flight finishes before this reads, and is then refused below.
  await sql`SELECT 1 FROM bank_statement_imports WHERE id = ${importId}::uuid AND company_id = ${companyId} FOR UPDATE`;
  const imp = await getImport(companyId, importId);
  if (!imp) throw new ExtractionActionRefusedError('NOT_FOUND', 'Statement not found.'); // 404, before any write
  const notReady = notReadyError(imp.status);
  if (notReady) throw notReady;
  if (imp.status === 'committed') throw new ExtractionActionRefusedError('ALREADY_COMMITTED', 'Cannot roll back a committed import');
  if (imp.status === 'rolled_back') return; // a second click: already done, nothing to write

  // The status test is in the UPDATE too: the read above is not what decides, the row count is.
  const rolledBack = (await sql`
    UPDATE bank_statement_imports
    SET status = 'rolled_back', updated_at = NOW()
    WHERE id = ${importId}::uuid AND company_id = ${companyId} AND status IN ('extracted', 'reviewing')
    RETURNING id
  `) as DbRow[];
  if (rolledBack.length === 0) throw new Error(`Import could not be rolled back: ${importId}`);

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
