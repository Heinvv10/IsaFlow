/**
 * Single loan row for the Period Close table.
 */
import Link from 'next/link';
import { Loader2 } from 'lucide-react';
import { fmt, fmtDate, PRODUCT_LABELS } from './types';
import type { LoanPeriodStatus } from '@/modules/accounting/services/loans/loanPeriodCloseService';
import { StatusBadge } from './PeriodCloseStatusBadge';

export interface LoanRowProps {
  loan: LoanPeriodStatus;
  isPosting: boolean;
  isLocked: boolean;
  isBulkPosting: boolean;
  onPost: (loanId: string) => void;
}

function rateLabel(loan: LoanPeriodStatus): string {
  if (loan.rateMode === 'FIXED') return `${loan.fixedRate ?? 0}%`;
  const sign = loan.rateMode === 'PRIME_PLUS' ? '+' : '−';
  return `Prime ${sign} ${loan.margin}%`;
}

export function PeriodCloseLoanRow({ loan, isPosting, isLocked, isBulkPosting, onPost }: LoanRowProps) {
  return (
    <tr className="border-b border-[var(--ff-border-light)] hover:bg-[var(--ff-bg-primary)]/40">
      <td className="px-4 py-3">
        <Link
          href={`/accounting/loans/${loan.loanId}`}
          className="font-medium text-[var(--ff-text-primary)] hover:text-teal-400"
        >
          {loan.reference || loan.loanId.slice(0, 8)}
        </Link>
        {loan.product && (
          <div className="text-xs text-[var(--ff-text-tertiary)] mt-0.5">
            {PRODUCT_LABELS[loan.product] ?? loan.product}
          </div>
        )}
        {loan.description && (
          <div className="text-xs text-[var(--ff-text-tertiary)] truncate max-w-[180px]">
            {loan.description}
          </div>
        )}
      </td>
      <td className="px-4 py-3 text-right font-mono text-[var(--ff-text-primary)]">
        {fmt(loan.principalBalance)}
      </td>
      <td className="px-4 py-3 text-[var(--ff-text-secondary)]">
        {rateLabel(loan)}
      </td>
      <td className="px-4 py-3 text-[var(--ff-text-secondary)]">
        {loan.nextPaymentDate ? fmtDate(loan.nextPaymentDate) : '—'}
      </td>
      <td className="px-4 py-3 text-right font-mono">
        <span className={loan.accruedInterest > 0 ? 'text-amber-400' : 'text-[var(--ff-text-tertiary)]'}>
          {fmt(loan.accruedInterest)}
        </span>
      </td>
      <td className="px-4 py-3">
        <StatusBadge status={loan.periodStatus} />
      </td>
      <td className="px-4 py-3 text-right">
        {loan.periodStatus === 'open' && !isLocked && (
          <button
            onClick={() => onPost(loan.loanId)}
            disabled={isPosting || isBulkPosting}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-teal-600/20 text-teal-400 hover:bg-teal-600/30 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isPosting
              ? <><Loader2 className="h-3 w-3 animate-spin" /> Posting…</>
              : 'Post'}
          </button>
        )}
        {loan.periodStatus === 'posted' && (
          <span className="text-xs text-[var(--ff-text-tertiary)]">Done</span>
        )}
      </td>
    </tr>
  );
}
