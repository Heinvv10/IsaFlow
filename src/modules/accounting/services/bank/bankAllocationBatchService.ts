/**
 * PRD-11 §4 — allocation batches.
 *
 * `bulk_allocate_bank_transactions` posts up to 500 journals in one call. To
 * undo that set an agent would otherwise have to remember 500 transaction ids
 * and issue 500 reversals, any one of which can fail halfway. A batch row plus
 * a stamp on each transaction makes the set addressable by one id, which is
 * what `reverse_bank_allocation_batch` reverses.
 *
 * The stamp lives on `bank_transactions.allocation_batch_id` rather than on
 * `gl_journal_entries`: reversal starts from the transaction (the journal is
 * reached through `matched_journal_line_id`), and a reversal must also clear
 * the stamp so the row can be re-allocated into a later batch. A journal-side
 * column could not be cleared without rewriting a posted entry.
 *
 * Every function takes companyId first and fences on it. `bank_transactions`
 * has no composite (id, company_id) key, so a stamp UPDATE that trusted only
 * the id would write across tenants.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';

export interface AllocationBatchInput {
  tool: string;
  lineCount: number;
  idempotencyKey: string | null;
}

/** Opens a batch and returns its id. Caller must be inside the request tx. */
export async function createAllocationBatch(
  companyId: string,
  userId: string,
  input: AllocationBatchInput,
): Promise<string> {
  const rows = (await sql`
    INSERT INTO bank_allocation_batches (company_id, created_by, tool, line_count, dry_run, idempotency_key)
    VALUES (${companyId}::uuid, ${userId}, ${input.tool}, ${input.lineCount}, FALSE, ${input.idempotencyKey})
    RETURNING id
  `) as DbRow[];
  const id = rows[0]?.id;
  // No row back means the INSERT did not happen (RLS refusal returns zero rows
  // rather than raising). Throwing here is what rolls the whole batch back —
  // returning a bogus id would post 500 journals nothing could reverse.
  if (!id) throw new Error('Failed to open the allocation batch');
  return String(id);
}

/**
 * Stamps the batch onto the transactions it allocated.
 *
 * Throws unless every id was stamped: a transaction that silently missed the
 * stamp is a posted journal outside the reversible set.
 */
export async function stampAllocationBatch(
  companyId: string,
  batchId: string,
  transactionIds: string[],
): Promise<void> {
  if (transactionIds.length === 0) return;
  const rows = (await sql`
    UPDATE bank_transactions
    SET allocation_batch_id = ${batchId}::uuid
    WHERE company_id = ${companyId}::uuid AND id = ANY(${transactionIds}::uuid[])
    RETURNING id
  `) as DbRow[];
  if (rows.length !== new Set(transactionIds).size) {
    throw new Error('Allocation batch stamp did not cover every transaction');
  }
}

/**
 * The transactions in a batch, or `null` when the batch does not exist in this
 * company. `null` and "another tenant's batch" are deliberately the same
 * answer — the caller renders both as the generic NOT_FOUND.
 */
export async function getAllocationBatchTransactionIds(
  companyId: string,
  batchId: string,
): Promise<string[] | null> {
  const batch = (await sql`
    SELECT id FROM bank_allocation_batches
    WHERE id = ${batchId}::uuid AND company_id = ${companyId}::uuid
  `) as DbRow[];
  if (batch.length === 0) return null;

  const rows = (await sql`
    SELECT id FROM bank_transactions
    WHERE company_id = ${companyId}::uuid AND allocation_batch_id = ${batchId}::uuid
    ORDER BY transaction_date ASC, id ASC
  `) as DbRow[];
  return rows.map((r) => String(r.id));
}

/** Clears the stamp after a batch has been reversed, so the rows can be re-allocated. */
export async function clearAllocationBatch(
  companyId: string,
  batchId: string,
  transactionIds: string[],
): Promise<void> {
  if (transactionIds.length === 0) return;
  await sql`
    UPDATE bank_transactions
    SET allocation_batch_id = NULL
    WHERE company_id = ${companyId}::uuid
      AND allocation_batch_id = ${batchId}::uuid
      AND id = ANY(${transactionIds}::uuid[])
  `;
}
