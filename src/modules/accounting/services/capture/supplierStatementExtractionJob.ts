/**
 * Supplier statement extraction job — reads an uploaded supplier statement in
 * the background and moves its supplier_statement_reconciliations row out of
 * 'extracting' to 'unreconciled', matched against the supplier's bills.
 *
 * Started by createReconciliation through runAfterCommit, so it runs after the
 * upload's COMMIT, outside any request, as the pool role with no row-level
 * security: EVERY statement here names the company. The lines table has no
 * company column, so its rows are written only after the company-scoped parent
 * is locked `FOR UPDATE ... status = 'extracting'` in the same transaction as
 * the move to 'unreconciled': a row that was retried or deleted meanwhile is
 * neither overwritten nor given a second set of lines by a late result. A retry bumps
 * `extraction_attempt`; every write is also guarded by the attempt the job claimed, so a read thought
 * dead (stale) that finishes or fails late cannot touch the row its retry is reading.
 *
 * Never throws: a failure is recorded on the row (a user-safe message) and the
 * row ends 'failed'. A job that dies outright leaves the row 'extracting' with
 * no heartbeat, which readers report as interrupted (statementExtractionState).
 */

import { sql, withTransaction } from '@/lib/neon';
import { log } from '@/lib/logger';
import { asAtTodayStr } from '@/modules/accounting/services/shared/softDeleteLedgerPresence';
import { describeExtractionFailure } from '@/modules/accounting/services/bank/statementExtractionState';
import { extractSupplierStatementFromDocument } from './supplierStatementExtraction';
import { measureOurSide } from './supplierStatementMeasure';
import { buildInserts } from './supplierStatementMatchHelper';
import { loadSupplierInvoices, replaceStatementLines } from './supplierStatementReconDb';

type DbRow = Record<string, unknown>;

async function heartbeat(companyId: string, reconId: string, attempt: number, done: number, total: number): Promise<void> {
  await sql`
    UPDATE supplier_statement_reconciliations
    SET extraction_heartbeat_at = NOW(), extraction_pages_done = ${done}, extraction_pages_total = ${total}
    WHERE id = ${reconId}::uuid AND company_id = ${companyId} AND status = 'extracting'
      AND extraction_attempt = ${attempt}
  `;
}

async function markFailed(companyId: string, reconId: string, attempt: number, err: unknown): Promise<void> {
  const { message, code } = describeExtractionFailure(err, 'supplier');
  const failed = (await sql`
    UPDATE supplier_statement_reconciliations
    SET status = 'failed', extraction_error = ${message}, extraction_error_code = ${code}, updated_at = NOW()
    WHERE id = ${reconId}::uuid AND company_id = ${companyId} AND status = 'extracting'
      AND extraction_attempt = ${attempt}
    RETURNING id
  `) as DbRow[];
  log.info('supplierStatementRecon: extraction failed', { reconId, code, recorded: failed.length === 1 }, 'recon-service');
}

/** Read the statement behind `reconId` and finish its row. See the file header. */
export async function runSupplierStatementExtraction(companyId: string, reconId: string): Promise<void> {
  try {
    const claimed = (await sql`
      SELECT supplier_id, source_document_id, extraction_attempt FROM supplier_statement_reconciliations
      WHERE id = ${reconId}::uuid AND company_id = ${companyId} AND status = 'extracting'
    `) as DbRow[];
    const row = claimed[0];
    if (!row) {
      log.warn('supplierStatementRecon: reconciliation is no longer extracting, nothing to do', { reconId }, 'recon-service');
      return;
    }
    const supplierId = row.supplier_id as string;
    const attempt = Number(row.extraction_attempt);

    try {
      const extraction = await extractSupplierStatementFromDocument(
        companyId, row.source_document_id as string, (done, total) => heartbeat(companyId, reconId, attempt, done, total),
      );
      if (extraction.warnings.length > 0) {
        log.warn('Supplier statement extraction warnings', { reconId, warnings: extraction.warnings }, 'recon-service');
      }

      const statementDate = extraction.statementDate ?? asAtTodayStr();
      const supplierBalance = extraction.closingBalance ?? 0;
      const { isaflowBalance, variance } = await measureOurSide(companyId, supplierId, statementDate, supplierBalance);
      const invoices = await loadSupplierInvoices(
        companyId, supplierId, extraction.periodStart ?? null, extraction.periodEnd ?? null,
      );
      const { inserts, confidences } = buildInserts(reconId, extraction.lines, invoices);
      const count = (reason: string) => inserts.filter((l) => l.mismatchReason === reason).length;

      const saved = await withTransaction(async (tx) => {
        const locked = await tx`
          SELECT id FROM supplier_statement_reconciliations
          WHERE id = ${reconId}::uuid AND company_id = ${companyId} AND status = 'extracting'
            AND extraction_attempt = ${attempt}
          FOR UPDATE
        `;
        if (locked.length === 0) return false;
        await replaceStatementLines(tx, reconId, inserts);
        await tx`
          UPDATE supplier_statement_reconciliations
          SET status = 'unreconciled', statement_date = ${statementDate}::date,
              period_start = ${extraction.periodStart ?? null}::date, period_end = ${extraction.periodEnd ?? null}::date,
              supplier_balance = ${supplierBalance}, isaflow_balance = ${isaflowBalance}, variance = ${variance},
              missing_in_isaflow_count = ${count('missing_in_isaflow')},
              missing_in_statement_count = ${count('missing_in_statement')},
              amount_diff_count = ${count('amount_diff')},
              extraction_error = NULL, extraction_error_code = NULL, updated_at = NOW()
          WHERE id = ${reconId}::uuid AND company_id = ${companyId} AND status = 'extracting'
            AND extraction_attempt = ${attempt}
        `;
        return true;
      });
      if (!saved) {
        log.warn('supplierStatementRecon: reconciliation is no longer extracting, result dropped', { reconId }, 'recon-service');
        return;
      }

      const exact = confidences.filter((c) => c === 1.0).length;
      const fuzzy = confidences.filter((c) => c === 0.85).length;
      log.info('supplierStatementRecon: extraction complete', {
        reconId, total: inserts.length, exact, fuzzy, unmatched: inserts.length - exact - fuzzy,
      }, 'recon-service');
    } catch (err) {
      await markFailed(companyId, reconId, attempt, err);
    }
  } catch (err) {
    log.error('supplierStatementRecon: could not record the extraction outcome', {
      reconId, error: err instanceof Error ? err.message : String(err),
    }, 'recon-service');
  }
}
