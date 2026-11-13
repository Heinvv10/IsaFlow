/**
 * The review / reconciliation chip on a bank line (Hein, 2026-11-12; migration 980). Reconciled lines stay on the
 * Reviewed tab: "Reconciled · <statement date>" links to the reconciliation that holds the line; a line reconciled in
 * the Sage import has none to link. A reviewed line not yet reconciled reads "Reviewed". The tooltip says who
 * reviewed it and when ("reviewer unknown" for lines reviewed before reviews were recorded).
 */
import Link from 'next/link';
import { formatDisplayDate, formatDisplayDateTime } from '@/utils/dateFormat';
import type { BankTx } from './bankTxTypes';

function reviewedTitle(tx: BankTx): string {
  if (!tx.reviewedAt) return 'Not reviewed in the app';
  const when = formatDisplayDateTime(tx.reviewedAt);
  return `Reviewed ${when} by ${tx.reviewedByName ?? 'reviewer unknown'}`;
}

const CHIP = 'ml-1 inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium';

export function BankTxReviewBadge({ tx }: { tx: BankTx }) {
  if (tx.status === 'reconciled') {
    const title = reviewedTitle(tx);
    const cls = `${CHIP} bg-teal-100 text-teal-800 dark:bg-teal-900/40 dark:text-teal-300`;
    if (!tx.reconciliationId) return <span className={cls} title={title}>Reconciled (Sage)</span>;
    const date = tx.reconStatementDate ? ` · ${formatDisplayDate(tx.reconStatementDate)}` : '';
    return (
      <Link href={`/accounting/bank-reconciliation/${tx.reconciliationId}`} className={`${cls} hover:underline`} title={title}>
        Reconciled{date}
      </Link>
    );
  }
  if (!tx.reviewedAt) return null;
  return (
    <span className={`${CHIP} bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300`} title={reviewedTitle(tx)}>
      Reviewed
    </span>
  );
}
