/**
 * A batch Netcash may hold is not undone (AP-01). Cancelling it, or reversing it, puts its bills back in the
 * payable pool, where a new batch pays them again while the first file is still with Netcash. So both refuse while
 * the batch has a netcash_submissions row that is not 'failed' (submitted, processing, completed, pending or
 * unknown): only a DEFINITE rejection frees the batch. The operator who has checked Netcash and knows the batch was
 * not paid sets the row 'failed' (pages/api/accounting/netcash/.claude.md).
 *
 * Call it with the batch row ALREADY locked by this transaction (cancelBatch: FOR NO KEY UPDATE; the reversal: FOR
 * UPDATE). netcash/submit holds that row FOR SHARE from before it claims until it commits, so a submit in flight is
 * waited for and its claim is visible here; one that starts later waits on this lock and then reads the new status.
 * The submission row is read FOR SHARE so its settle (an UPDATE on the claim connection) cannot change it under us.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { SupplierPaymentRefusal } from './supplierPaymentRefusal';

/** The batch's live (non-failed) Netcash submission, if any - read without a lock. */
export async function liveNetcashSubmission(companyId: string, batchId: string): Promise<{ id: string; status: string } | null> {
  const held = (await sql`
    SELECT id, status FROM netcash_submissions
    WHERE company_id = ${companyId}::UUID AND batch_id = ${batchId}::UUID AND status <> 'failed'
    ORDER BY created_at LIMIT 1
  `) as DbRow[];
  return held[0] ? { id: String(held[0].id), status: String(held[0].status) } : null;
}

export async function assertBatchNotSentToNetcash(
  companyId: string, batchId: string, batchNumber: string, action: 'cancelled' | 'reversed',
): Promise<void> {
  const held = (await sql`
    SELECT id, status FROM netcash_submissions
    WHERE company_id = ${companyId}::UUID AND batch_id = ${batchId}::UUID AND status <> 'failed'
    ORDER BY created_at LIMIT 1
    FOR SHARE
  `) as DbRow[];
  if (held[0]) {
    throw new SupplierPaymentRefusal(
      `Batch ${batchNumber} cannot be ${action}: it was sent to Netcash (submission ${String(held[0].id)}, status `
      + `${String(held[0].status)}). Check Netcash first; only a rejected submission frees the batch.`);
  }
}
