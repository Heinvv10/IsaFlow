/**
 * Hein 2026-11-12 (migration 980): a reconciliation cannot be completed while a line it would reconcile is
 * unreviewed. The reconciliation screen names those lines (a chip per line) and says where to review them: the
 * Bank Transactions New tab, where Review stamps them. Matching a line here does not review it.
 */
import Link from 'next/link';
import { AlertCircle } from 'lucide-react';
import type { BankTransaction } from '@/modules/accounting/types/bank.types';

/** A line this reconciliation would reconcile that nobody has reviewed yet. */
export const isUnreviewedMatch = (tx: BankTransaction): boolean => tx.status !== 'reconciled' && !tx.reviewedAt;

export function NotReviewedChip() {
  return (
    <span className="text-xs px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
      Not reviewed
    </span>
  );
}

export function ReconUnreviewedNotice({ count, bankAccountId }: { count: number; bankAccountId: string }) {
  if (count === 0) return null;
  return (
    <div className="flex items-center gap-2 p-3 rounded-lg bg-amber-500/10 text-amber-700 dark:text-amber-300 text-sm">
      <AlertCircle className="h-4 w-4 shrink-0" />
      <span>
        {count} matched transaction{count === 1 ? ' is' : 's are'} not reviewed yet, so this reconciliation cannot be
        completed. Review them on{' '}
        <Link href={`/accounting/bank-transactions?account_id=${bankAccountId}`} className="underline">
          Bank Transactions
        </Link>{' '}
        (New tab), then complete it here.
      </span>
    </div>
  );
}
