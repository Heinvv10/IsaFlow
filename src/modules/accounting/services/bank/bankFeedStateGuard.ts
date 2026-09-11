/**
 * Bank feed lifecycle guard. A feed row is `pending` or `removed` at the bank
 * until the provider posts it. Such a row is visible in the review queue but
 * no accounting mutation may touch it.
 *
 * Migration 675's trigger refuses the write in the database whatever the
 * writer. That backstop answers with a 500 (the transaction rolls back). This
 * module lets the locked mutators refuse FIRST, from the row they already
 * hold, before any write, so the caller gets a 4xx with a reason instead.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import type { FeedState } from '../../types/bank.types';
import { BankAllocationRefusal } from './bankAllocationRefusal';

export type { FeedState };
const FEED_STATES: readonly FeedState[] = ['pending', 'posted', 'removed'];

export function feedStateOf(row: { feed_state?: unknown }): FeedState {
  if (row.feed_state === undefined || row.feed_state === null) return 'posted';
  const s = String(row.feed_state);
  if (!(FEED_STATES as readonly string[]).includes(s)) throw new Error(`Unknown feed_state "${s}"`);
  return s as FeedState;
}

export class BankTransactionNotPostedError extends Error {
  readonly code = 'BANK_TX_NOT_POSTED' as const;
  constructor(bankTxId: string, readonly feedState: FeedState, verb: string) {
    super(
      feedState === 'pending'
        ? `Bank transaction ${bankTxId} is still pending at the bank — you can ${verb} it once it posts.`
        : `Bank transaction ${bankTxId} was removed by the bank — it cannot be used to ${verb}.`,
    );
    this.name = 'BankTransactionNotPostedError';
  }
}

export function isBankTransactionNotPosted(err: unknown): err is BankTransactionNotPostedError {
  return err instanceof Error && (err as { code?: unknown }).code === 'BANK_TX_NOT_POSTED';
}

export function assertFeedPosted(row: { id?: unknown; feed_state?: unknown }, verb: string): void {
  const state = feedStateOf(row);
  if (state !== 'posted') throw new BankTransactionNotPostedError(String(row.id ?? ''), state, verb);
}

/**
 * `allocateTransaction` / `splitAllocateTransaction`'s feed-state refusal.
 * Wrapped in `BankAllocationRefusal` (not the bare `BankTransactionNotPostedError`)
 * so the routes that already answer that class with a 4xx keep doing so — see
 * `bankAllocationRefusal.ts`'s own doc comment for why bare throws there become
 * a 500. `feedStateOf` is computed once, not twice, to build the message.
 */
export function assertPostedForAllocation(
  row: { feed_state?: unknown }, bankTxId: string, verb: string,
): void {
  const state = feedStateOf(row);
  if (state !== 'posted') {
    throw new BankAllocationRefusal(new BankTransactionNotPostedError(bankTxId, state, verb).message);
  }
}

/** Unlocked read for routes that must refuse before their first write. */
export async function readFeedState(companyId: string, bankTxId: string): Promise<FeedState | null> {
  const rows = (await sql`
    SELECT feed_state FROM bank_transactions
    WHERE id = ${bankTxId}::UUID AND company_id = ${companyId}::UUID`) as DbRow[];
  return rows[0] ? feedStateOf(rows[0]) : null;
}
