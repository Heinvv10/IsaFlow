/**
 * Supplier statement reconciliation — start, retry and delete.
 *
 * The upload answers at once with an 'extracting' row and a background job
 * reads the statement after the request commits (supplierStatementExtractionJob:
 * a dense page takes the VLM ~55 s, longer than a request may run). A failed read
 * (or one interrupted for 5 minutes, statementExtractionState) can be retried,
 * except a statement with too many pages, or deleted.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { runAfterCommit } from '@/lib/afterCommit';
import { asAtTodayStr } from '@/modules/accounting/services/shared/softDeleteLedgerPresence';
import { explainRefusal, STALE_AFTER_MINUTES } from '@/modules/accounting/services/bank/statementExtractionState';
import { runSupplierStatementExtraction } from './supplierStatementExtractionJob';
import { fetchFullReconciliation } from './supplierStatementReconDb';
import type { SupplierStatementReconciliation } from './supplierStatementReconService';

type DbRow = Record<string, unknown>;

/** Insert the reconciliation as 'extracting' (placeholder figures) and queue the read. */
export async function createReconciliation(
  companyId: string,
  supplierId: string,
  capturedDocumentId: string,
  userId: string,
): Promise<SupplierStatementReconciliation> {
  const [headerRow] = (await sql`
    INSERT INTO supplier_statement_reconciliations
      (company_id, supplier_id, source_document_id, statement_date,
       supplier_balance, isaflow_balance, variance, status, created_by)
    VALUES (
      ${companyId}, ${supplierId}::uuid, ${capturedDocumentId}::uuid, ${asAtTodayStr()}::date,
      0, 0, 0, 'extracting', ${userId}::uuid
    )
    RETURNING id
  `) as DbRow[];
  if (!headerRow) throw new Error('Failed to insert reconciliation header');
  const reconId = headerRow.id as string;

  runAfterCommit('supplier statement extraction', () => runSupplierStatementExtraction(companyId, reconId));
  log.info('supplierStatementRecon: queued for extraction', { reconId, capturedDocumentId }, 'recon-service');

  const result = await fetchFullReconciliation(companyId, reconId);
  if (!result) throw new Error('Failed to retrieve created reconciliation');
  return result;
}

/**
 * Put a failed reconciliation (or one whose read was interrupted) back to 'extracting' and read it again.
 * One guarded UPDATE decides: a double click, or a statement that is too long, matches no row.
 */
export async function retryReconciliation(companyId: string, reconId: string): Promise<SupplierStatementReconciliation> {
  const [updated] = (await sql`
    UPDATE supplier_statement_reconciliations
    SET status = 'extracting', extraction_attempt = extraction_attempt + 1, extraction_error = NULL, extraction_error_code = NULL,
        extraction_heartbeat_at = NOW(), extraction_pages_done = NULL, extraction_pages_total = NULL,
        updated_at = NOW()
    WHERE id = ${reconId}::uuid AND company_id = ${companyId}
      AND extraction_error_code IS DISTINCT FROM 'too_many_pages'
      AND (status = 'failed'
        OR (status = 'extracting' AND COALESCE(extraction_heartbeat_at, created_at) < NOW() - make_interval(mins => ${STALE_AFTER_MINUTES})))
    RETURNING id
  `) as DbRow[];
  if (!updated) throw explainRefusal('retry', await findHeader(companyId, reconId));

  runAfterCommit('supplier statement extraction', () => runSupplierStatementExtraction(companyId, reconId));
  log.info('supplierStatementRecon: queued for another extraction', { reconId }, 'recon-service');

  const result = await fetchFullReconciliation(companyId, reconId);
  if (!result) throw new Error('Failed to retrieve retried reconciliation');
  return result;
}

/** Delete a reconciliation that failed (or whose read was interrupted). The uploaded document is kept. */
export async function deleteFailedReconciliation(companyId: string, reconId: string): Promise<void> {
  const [deleted] = (await sql`
    DELETE FROM supplier_statement_reconciliations
    WHERE id = ${reconId}::uuid AND company_id = ${companyId}
      AND (status = 'failed'
        OR (status = 'extracting' AND COALESCE(extraction_heartbeat_at, created_at) < NOW() - make_interval(mins => ${STALE_AFTER_MINUTES})))
    RETURNING id
  `) as DbRow[];
  if (!deleted) throw explainRefusal('delete', await findHeader(companyId, reconId));
  log.info('supplierStatementRecon: failed reconciliation deleted', { reconId }, 'recon-service');
}

async function findHeader(companyId: string, reconId: string): Promise<DbRow | null> {
  const [row] = (await sql`
    SELECT * FROM supplier_statement_reconciliations WHERE id = ${reconId}::uuid AND company_id = ${companyId} LIMIT 1
  `) as DbRow[];
  return row ?? null;
}
