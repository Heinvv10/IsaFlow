/**
 * `findBankTransactionAllocationStates`, split out of bankTransactionLookupService.ts (which re-exports it, so every
 * caller and every `vi.mock` of that module keeps working) to keep that file under the 300-line ceiling.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { feedStateOf, type FeedState } from './bankFeedStateGuard';

/**
 * The transaction's current status, or `null` when it does not exist in this
 * company (another tenant's row reads identically to a missing one).
 *
 * Exists so the MCP allocate/reverse tools can refuse an unallocatable row
 * BEFORE calling the service. The services raise the same refusals themselves,
 * but by then the tool cannot tell a pre-write refusal from a failure that
 * struck after a journal was already posted — and the two need opposite
 * handling: a refusal is reported, a mid-write failure must be rethrown so the
 * registry's savepoint unwinds it.
 */
export interface BankTransactionAllocationState {
  id: string;
  status: string;
  /** The journal line the row is allocated against — null when unallocated. */
  matchedJournalLineId: string | null;
  /** A pending/removed feed row cannot be allocated at all. */
  feedState: FeedState;
  /**
   * Signed line amount. Carried so a batch caller can size an allocation
   * without a second read per line — a 200-line batch would otherwise make
   * 200 round trips to ask what it already selected.
   */
  amount: number;
  transactionDate: string | Date | null; // its allocation journal's date — a batch's up-front year lock (numberYearLocks)
}

/**
 * Allocation state for a WHOLE set of transactions, in ONE company-scoped
 * query. Rows absent from the map do not exist in this company (another
 * tenant's row is indistinguishable from a missing one, deliberately).
 *
 * `bulk_allocate_bank_transactions` calls this once for up to 500 resolved ids
 * before it posts anything — the alternative was one `getBankTransactionStatus`
 * per line inside a request that already holds every row's lock.
 *
 * Both columns, not just `status`. A row can carry `status='allocated'` with no
 * journal (a half-finished older write) and, more importantly, the journal is
 * what `reverse_bank_allocation_batch` navigates by — a partition that reads
 * only `status` passes a fixture and fails production, which is exactly how the
 * #261 batch got through.
 */
export async function findBankTransactionAllocationStates(
  companyId: string,
  bankTxIds: readonly string[],
): Promise<Map<string, BankTransactionAllocationState>> {
  const ids = [...new Set(bankTxIds)];
  const byId = new Map<string, BankTransactionAllocationState>();
  if (ids.length === 0) return byId;

  const rows = (await sql`
    SELECT id, status, matched_journal_line_id, amount, feed_state, transaction_date
    FROM bank_transactions
    WHERE company_id = ${companyId}::UUID AND id = ANY(${ids}::UUID[])
  `) as DbRow[];

  for (const row of rows) {
    const id = String(row.id);
    byId.set(id, {
      id,
      status: row.status === null || row.status === undefined ? '' : String(row.status),
      matchedJournalLineId:
        row.matched_journal_line_id === null || row.matched_journal_line_id === undefined
          ? null
          : String(row.matched_journal_line_id),
      amount: Number(row.amount ?? 0),
      feedState: feedStateOf(row),
      transactionDate: (row.transaction_date as string | Date | null | undefined) ?? null,
    });
  }
  return byId;
}
