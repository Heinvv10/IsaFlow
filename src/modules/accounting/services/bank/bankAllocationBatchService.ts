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
 * The stamp says the row was PART of a batch; it does NOT say the journal now
 * hanging off the row is the one the batch posted. `bank_allocation_batch_lines`
 * (mig 515) records that, so the reverse tool can refuse to unwind a journal it
 * did not create — a check that does not depend on every present and future
 * write path remembering to clear a column.
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
  // No row back means the INSERT did not happen (an RLS refusal returns zero
  // rows rather than raising). Throwing here is what rolls the whole batch
  // back — returning a bogus id would post 500 journals nothing could reverse.
  if (!id) throw new Error('Failed to open the allocation batch');
  return String(id);
}

export interface AllocationBatchLine {
  transactionId: string;
  journalEntryId: string;
}

/**
 * Records what the batch posted, then stamps the batch onto those transactions.
 *
 * Both halves matter. The stamp makes the set findable; the recorded
 * `journal_entry_id` is what lets the reverse tool prove the journal it is
 * about to reverse is the one THIS batch posted.
 *
 * Throws unless every id was stamped: a transaction that silently missed the
 * stamp is a posted journal outside the reversible set.
 */
export async function recordAllocationBatchLines(
  companyId: string,
  batchId: string,
  lines: AllocationBatchLine[],
): Promise<void> {
  if (lines.length === 0) return;
  const txIds = lines.map((l) => l.transactionId);
  const jeIds = lines.map((l) => l.journalEntryId);

  // UNNEST rather than a loop: 500 lines would otherwise be 500 round trips
  // while the batch holds one connection's locks.
  await sql`
    INSERT INTO bank_allocation_batch_lines (company_id, batch_id, bank_transaction_id, journal_entry_id)
    SELECT ${companyId}::uuid, ${batchId}::uuid, t.tx, t.je
    FROM UNNEST(${txIds}::uuid[], ${jeIds}::uuid[]) AS t(tx, je)
  `;

  const rows = (await sql`
    UPDATE bank_transactions
    SET allocation_batch_id = ${batchId}::uuid
    WHERE company_id = ${companyId}::uuid AND id = ANY(${txIds}::uuid[])
    RETURNING id
  `) as DbRow[];
  if (rows.length !== new Set(txIds).size) {
    throw new Error('Allocation batch stamp did not cover every transaction');
  }
}

export interface AllocationBatchLineState extends AllocationBatchLine {
  /** The journal currently behind the transaction — null once it is unallocated. */
  currentJournalEntryId: string | null;
}

/**
 * The batch's lines, each with the transaction's CURRENT journal, or `null`
 * when the batch does not exist in this company. `null` and "another tenant's
 * batch" are deliberately the same answer — the caller renders both as the
 * generic NOT_FOUND.
 *
 * The caller compares `journalEntryId` against `currentJournalEntryId` and
 * leaves alone anything that has moved on.
 */
export async function getAllocationBatchLines(
  companyId: string,
  batchId: string,
): Promise<AllocationBatchLineState[] | null> {
  const batch = (await sql`
    SELECT id FROM bank_allocation_batches
    WHERE id = ${batchId}::uuid AND company_id = ${companyId}::uuid
  `) as DbRow[];
  if (batch.length === 0) return null;

  const rows = (await sql`
    SELECT l.bank_transaction_id, l.journal_entry_id, jl.journal_entry_id AS current_journal_entry_id
    FROM bank_allocation_batch_lines l
    JOIN bank_transactions bt
      ON bt.id = l.bank_transaction_id AND bt.company_id = l.company_id
    LEFT JOIN gl_journal_lines jl
      ON jl.id = bt.matched_journal_line_id AND jl.company_id = l.company_id
    WHERE l.company_id = ${companyId}::uuid AND l.batch_id = ${batchId}::uuid
    ORDER BY bt.transaction_date ASC, bt.id ASC
  `) as DbRow[];

  return rows.map((r) => ({
    transactionId: String(r.bank_transaction_id),
    journalEntryId: String(r.journal_entry_id),
    currentJournalEntryId:
      r.current_journal_entry_id === null || r.current_journal_entry_id === undefined
        ? null
        : String(r.current_journal_entry_id),
  }));
}

/** Clears the stamp on the rows this batch actually reversed. */
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
