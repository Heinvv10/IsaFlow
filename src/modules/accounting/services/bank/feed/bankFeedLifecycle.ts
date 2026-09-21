// src/modules/accounting/services/bank/feed/bankFeedLifecycle.ts
/**
 * Pure lifecycle decision for a provider-identified feed transaction.
 * No I/O. The persistence layer applies whatever this returns. See the table
 * in docs/superpowers/plans/2026-09-11-bank-sync-v1-release-1.md, Task 6.
 */
import type { FeedState, NormalizedBankTransaction } from './bankIngestionTypes';

export interface ExistingFeedRow {
  id: string;
  feedState: FeedState;
  processed: boolean;
  transactionDate: string;
  valueDate: string | null;
  amount: number;
  description: string;
  reference: string | null;
  providerUpdatedAt: string | null;
}

export type ConflictReason =
  | 'processed_row_changed' | 'posted_row_removed' | 'posted_row_reverted_to_pending'
  | 'removed_row_reappeared' | 'unordered_change';

export type FeedDecision =
  | { kind: 'insert' }
  | { kind: 'ignore_removed_unknown' }
  | { kind: 'duplicate' }
  | { kind: 'refresh' }
  | { kind: 'post_pending' }
  | { kind: 'remove_pending' }
  | { kind: 'conflict'; reason: ConflictReason };

type Ordering = 'newer' | 'older_or_equal' | 'unknown';

function ordering(existing: string | null, incoming: string | undefined): Ordering {
  if (!existing || !incoming) return 'unknown';
  const e = Date.parse(existing);
  const i = Date.parse(incoming);
  if (Number.isNaN(e) || Number.isNaN(i)) return 'unknown';
  return i > e ? 'newer' : 'older_or_equal';
}

const cents = (n: number): number => Math.round(n * 100);

export function sameSourceValues(ex: ExistingFeedRow, inc: NormalizedBankTransaction): boolean {
  return ex.transactionDate === inc.transactionDate
    && (ex.valueDate ?? null) === (inc.valueDate ?? null)
    && cents(ex.amount) === cents(inc.amount)
    && ex.description === inc.description
    && (ex.reference ?? null) === (inc.reference ?? null);
}

const conflict = (reason: ConflictReason): FeedDecision => ({ kind: 'conflict', reason });

export function decideFeedTransition(
  existing: ExistingFeedRow | null,
  incoming: NormalizedBankTransaction,
): FeedDecision {
  if (!existing) return incoming.state === 'removed' ? { kind: 'ignore_removed_unknown' } : { kind: 'insert' };

  const order = ordering(existing.providerUpdatedAt, incoming.providerUpdatedAt);
  const same = sameSourceValues(existing, incoming);

  if (existing.feedState === 'removed') {
    return incoming.state === 'removed' ? { kind: 'duplicate' } : conflict('removed_row_reappeared');
  }

  if (existing.feedState === 'pending') {
    if (incoming.state === 'posted') return { kind: 'post_pending' };
    if (incoming.state === 'removed') return { kind: 'remove_pending' };
    if (same || order === 'older_or_equal') return { kind: 'duplicate' };
    return { kind: 'refresh' };
  }

  // existing posted
  if (order === 'older_or_equal') return { kind: 'duplicate' };
  if (incoming.state === 'removed') return conflict('posted_row_removed');
  if (incoming.state === 'pending') return conflict('posted_row_reverted_to_pending');
  if (same) return { kind: 'duplicate' };
  if (existing.processed) return conflict('processed_row_changed');
  return order === 'newer' ? { kind: 'refresh' } : conflict('unordered_change');
}
