/**
 * Bank statement extraction job — reads an uploaded statement in the background
 * and moves its bank_statement_imports row out of 'extracting'.
 *
 * Started by createImportFromDocument through runAfterCommit, so it runs after
 * the upload's COMMIT, outside any request, as the pool role with no row-level
 * security: EVERY statement here names the company, and every move out of
 * 'extracting' is guarded by `status = 'extracting'`, so a row that was retried,
 * rolled back or deleted meanwhile is never overwritten by a late result.
 *
 * Never throws: a failure is recorded on the row (a user-safe message) and the
 * row ends 'failed'. A job that dies outright leaves the row 'extracting' with
 * no heartbeat, which readers report as interrupted (statementExtractionState).
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { ExtractedBankStatement } from '@/modules/accounting/types/documentCapture.types';
import { parsedDayWindowError } from '../../utils/journalDateWindow';
import { runDedupPass } from './bankStatementDedupHelpers';
import { extractBankStatementFromDocument } from './bankStatementExtraction';
import { describeExtractionFailure } from './statementExtractionState';
import type { BankStatementRow } from './bankStatementOcrService';

type DbRow = Record<string, unknown>;

async function heartbeat(companyId: string, importId: string, done: number, total: number): Promise<void> {
  await sql`
    UPDATE bank_statement_imports
    SET extraction_heartbeat_at = NOW(), extraction_pages_done = ${done}, extraction_pages_total = ${total}
    WHERE id = ${importId}::uuid AND company_id = ${companyId} AND status = 'extracting'
  `;
}

async function buildRows(
  companyId: string, bankAccountId: string, extraction: ExtractedBankStatement,
): Promise<{ rows: BankStatementRow[]; warnings: string[] }> {
  const dedup = await runDedupPass(companyId, bankAccountId, extraction.transactions);

  // sec-numrace S4: a line dated outside the ledger window keeps no date (commit skips it) and says why, as the CSV
  // import's row error does (utils/journalDateWindow).
  const outside = (d: string | null | undefined) => (d ? parsedDayWindowError(d) : null);
  const warnings = [...extraction.warnings, ...extraction.transactions.flatMap((tx) => {
    const why = outside(tx.date);
    return why ? [`${why} (${tx.description.slice(0, 60)})`] : [];
  })];
  const rows = extraction.transactions.map((tx, i): BankStatementRow => ({
    date: outside(tx.date) ? '' : tx.date ?? '',
    description: tx.description,
    reference: tx.reference ?? null,
    amount: tx.amount,
    runningBalance: tx.balance ?? null,
    isDuplicate: dedup[i]!.isDuplicate,
    duplicateOfBankTxId: dedup[i]!.duplicateOfBankTxId,
    duplicateMatchConfidence: dedup[i]!.duplicateMatchConfidence,
  }));
  return { rows, warnings };
}

async function markFailed(companyId: string, importId: string, err: unknown): Promise<void> {
  const { message, code } = describeExtractionFailure(err, 'bank');
  const failed = (await sql`
    UPDATE bank_statement_imports
    SET status = 'failed', extraction_error = ${message}, extraction_error_code = ${code}, updated_at = NOW()
    WHERE id = ${importId}::uuid AND company_id = ${companyId} AND status = 'extracting'
    RETURNING id
  `) as DbRow[];
  log.info('bankStatementOcr: extraction failed', { importId, code, recorded: failed.length === 1 }, 'bank-stmt-ocr');
}

/** Read the statement behind `importId` and finish its row. See the file header. */
export async function runBankStatementExtraction(companyId: string, importId: string): Promise<void> {
  try {
    const claimed = (await sql`
      SELECT bank_account_id, source_document_id FROM bank_statement_imports
      WHERE id = ${importId}::uuid AND company_id = ${companyId} AND status = 'extracting'
    `) as DbRow[];
    const row = claimed[0];
    if (!row) {
      log.warn('bankStatementOcr: import is no longer extracting, nothing to do', { importId }, 'bank-stmt-ocr');
      return;
    }

    try {
      const extraction = await extractBankStatementFromDocument(
        companyId, row.source_document_id as string, (done, total) => heartbeat(companyId, importId, done, total),
      );
      const { rows, warnings } = await buildRows(companyId, row.bank_account_id as string, extraction);
      const duplicateCount = rows.filter((r) => r.isDuplicate).length;
      const summary = JSON.stringify({ rows, warnings });
      const saved = (await sql`
        UPDATE bank_statement_imports
        SET period_start = ${extraction.statementPeriod?.from ?? null}::date,
            period_end = ${extraction.statementPeriod?.to ?? null}::date,
            opening_balance = ${extraction.openingBalance ?? null},
            closing_balance = ${extraction.closingBalance ?? null},
            row_count = ${rows.length}, imported_count = 0, duplicate_count = ${duplicateCount},
            status = 'extracted', extraction_summary = ${summary}::jsonb,
            extraction_error = NULL, extraction_error_code = NULL, updated_at = NOW()
        WHERE id = ${importId}::uuid AND company_id = ${companyId} AND status = 'extracting'
        RETURNING id
      `) as DbRow[];
      if (saved.length === 0) {
        log.warn('bankStatementOcr: import is no longer extracting, result dropped', { importId }, 'bank-stmt-ocr');
        return;
      }
      log.info('bankStatementOcr: extraction complete', { importId, rowCount: rows.length, duplicateCount }, 'bank-stmt-ocr');
    } catch (err) {
      await markFailed(companyId, importId, err);
    }
  } catch (err) {
    log.error('bankStatementOcr: could not record the extraction outcome', {
      importId, error: err instanceof Error ? err.message : String(err),
    }, 'bank-stmt-ocr');
  }
}
