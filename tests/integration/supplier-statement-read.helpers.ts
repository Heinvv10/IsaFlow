/**
 * Upload a supplier statement the way it now happens: `createReconciliation` answers with an 'extracting' row
 * and queues the read for after the request commits, then the background job reads the statement and writes
 * the figures. A suite that wants the figures drives both steps and reads the finished reconciliation.
 *
 * The caller mocks two boundaries and nothing else, as the suites always did:
 *   - `@/lib/afterCommit` `runAfterCommit` as a no-op, so the job runs here, once, awaited, instead of
 *     detached on its own;
 *   - `.../capture/supplierStatementExtraction` `extractSupplierStatementFromDocument`, the VLM read of the
 *     stored bytes. It must return at least one line: a read that finds none now fails (no_lines).
 * The balance query, the variance arithmetic, the matching and the persisted rows are the real ones.
 */
import { createReconciliation } from '@/modules/accounting/services/capture/supplierStatementLifecycle';
import { runSupplierStatementExtraction } from '@/modules/accounting/services/capture/supplierStatementExtractionJob';
import {
  getReconciliation,
  type SupplierStatementReconciliation,
} from '@/modules/accounting/services/capture/supplierStatementReconService';

export async function createAndRead(
  companyId: string, supplierId: string, documentId: string, userId: string,
): Promise<SupplierStatementReconciliation> {
  const created = await createReconciliation(companyId, supplierId, documentId, userId);
  if (created.status !== 'extracting') throw new Error(`expected an extracting reconciliation, got ${created.status}`);
  await runSupplierStatementExtraction(companyId, created.id);
  const read = await getReconciliation(companyId, created.id);
  if (!read) throw new Error('the reconciliation vanished after its read');
  if (read.status === 'failed') throw new Error(`the read failed: ${read.extractionError}`);
  return read;
}
