/**
 * Find the ALLOCATED transactions in one bank account over a date range.
 *
 * `reverse_bank_allocation_batch` navigates by a `batch_id`, which only exists
 * for allocations made by `bulk_allocate_bank_transactions`. Allocations
 * created by a bank RULE or by an import carry no batch, so they could only be
 * reversed one at a time. During the Velocity Fibre migration nine rule-created
 * allocations had to be unwound individually, and three of the nine were
 * blocked by an approval layer part-way through — leaving the account
 * consistent but the job half-done, with no way to tell from the outside which
 * half.
 *
 * This is the read half of the range reversal. It lives in its own file rather
 * than in `bankTransactionLookupService` because it is the only lookup keyed by
 * (account, date range) instead of by id, and that file is near the 300-line
 * cap.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';

export interface AllocatedRangeRow {
  id: string;
  transactionDate: string;
  amount: number;
  description: string | null;
  reference: string | null;
  /** The journal the allocation posted — what the reversal unwinds. */
  journalEntryId: string | null;
  /** Set when the allocation came from a bulk batch; null for rule/import ones. */
  allocationBatchId: string | null;
  /** The rule that created it, when one did — the thing to fix next. */
  allocationRuleName: string | null;
}

/**
 * Rows are returned ordered by ID, which is the deterministic lock order every
 * other bulk path uses. Reversal takes the same row locks as allocation, so an
 * unsorted loop deadlocks against a concurrent batch.
 *
 * "Allocated" means `matched_journal_line_id IS NOT NULL` — a posted journal
 * line — never `status` alone. A row can carry `status='allocated'` with no
 * journal from an older half-finished write, and reversing that would find
 * nothing to unwind while reporting success.
 */
export async function findAllocatedInRange(
  companyId: string,
  bankAccountId: string,
  fromDate: string,
  toDate: string,
  limit: number,
): Promise<AllocatedRangeRow[]> {
  const rows = (await sql`
    SELECT
      bt.id,
      bt.transaction_date,
      bt.amount,
      bt.description,
      bt.reference,
      bt.allocation_batch_id,
      jl.journal_entry_id,
      r.rule_name AS allocation_rule_name
    FROM bank_transactions bt
    LEFT JOIN gl_journal_lines jl
      ON jl.id = bt.matched_journal_line_id
     AND jl.company_id = bt.company_id
    LEFT JOIN bank_categorisation_rules r
      ON r.id = bt.allocation_rule_id
     AND r.company_id = bt.company_id
    WHERE bt.company_id = ${companyId}::UUID
      AND bt.bank_account_id = ${bankAccountId}::UUID
      AND bt.transaction_date >= ${fromDate}::DATE
      AND bt.transaction_date <= ${toDate}::DATE
      AND bt.matched_journal_line_id IS NOT NULL
    ORDER BY bt.id
    LIMIT ${limit}
  `) as DbRow[];

  return rows.map((r) => ({
    id: String(r.id),
    // pg returns a Date for a DATE column; both shapes have to survive.
    transactionDate: r.transaction_date instanceof Date
      ? r.transaction_date.toISOString().slice(0, 10)
      : String(r.transaction_date).slice(0, 10),
    amount: Number(r.amount),
    description: r.description === null || r.description === undefined ? null : String(r.description),
    reference: r.reference === null || r.reference === undefined ? null : String(r.reference),
    journalEntryId: r.journal_entry_id === null || r.journal_entry_id === undefined
      ? null : String(r.journal_entry_id),
    allocationBatchId: r.allocation_batch_id === null || r.allocation_batch_id === undefined
      ? null : String(r.allocation_batch_id),
    allocationRuleName: r.allocation_rule_name === null || r.allocation_rule_name === undefined
      ? null : String(r.allocation_rule_name),
  }));
}

/**
 * How many allocated rows the range holds, ignoring the cap.
 *
 * Reported alongside a capped result so a truncated reversal is VISIBLE. The
 * alternative — reversing the first N and saying nothing — is the exact
 * half-done state this tool exists to prevent, only harder to notice.
 */
export async function countAllocatedInRange(
  companyId: string,
  bankAccountId: string,
  fromDate: string,
  toDate: string,
): Promise<number> {
  const rows = (await sql`
    SELECT COUNT(*)::INT AS cnt
    FROM bank_transactions bt
    WHERE bt.company_id = ${companyId}::UUID
      AND bt.bank_account_id = ${bankAccountId}::UUID
      AND bt.transaction_date >= ${fromDate}::DATE
      AND bt.transaction_date <= ${toDate}::DATE
      AND bt.matched_journal_line_id IS NOT NULL
  `) as { cnt: number }[];
  return Number(rows[0]?.cnt ?? 0);
}
