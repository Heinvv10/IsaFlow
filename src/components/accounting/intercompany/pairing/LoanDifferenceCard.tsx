/** The loan-balance difference: this company's intercompany loan account against the partner's, before the cut-over. */
import { formatCurrency, formatDate } from '@/utils/formatters';
import type { LoanDifference } from '@/modules/accounting/services/intercompany/pairingTypes';
import { formatDrCr } from './pairingFormat';

export function LoanDifferenceCard({ loan, partnerName }: { loan: LoanDifference; partnerName: string }) {
  const agrees = loan.difference !== null && Math.abs(loan.difference) < 0.005;
  return (
    <section className="bg-[var(--ff-canvas-mid)] border border-[var(--ff-canvas-border)] rounded-xl p-5 space-y-3" data-testid="loan-difference">
      <h2 className="text-base font-semibold text-[var(--ff-text-primary)]">Intercompany loan balances</h2>
      <p className="text-xs text-ink-muted">
        Each company&apos;s loan account as at {formatDate(loan.asAt)}, the day before the cut-over. One company&apos;s receivable is the
        other&apos;s payable, so the two should cancel out. Opening balances carry over as they are; nothing is posted to close a difference.
      </p>
      <dl className="grid gap-3 sm:grid-cols-3">
        <div>
          <dt className="text-xs text-ink-muted">Your loan account</dt>
          <dd className="text-sm font-medium tabular-nums text-[var(--ff-text-primary)]" data-testid="loan-mine">{formatDrCr(loan.mine)}</dd>
        </div>
        <div>
          <dt className="text-xs text-ink-muted">{partnerName}&apos;s loan account</dt>
          <dd className="text-sm font-medium tabular-nums text-[var(--ff-text-primary)]" data-testid="loan-theirs">
            {loan.theirs === null ? <span className="text-ink-muted font-normal">Not available</span> : formatDrCr(loan.theirs)}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-ink-muted">Difference</dt>
          <dd data-testid="loan-difference-value" data-state={loan.difference === null ? 'unknown' : agrees ? 'agrees' : 'differs'}
            className={`text-sm font-medium tabular-nums ${loan.difference === null ? 'text-ink-muted' : agrees ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-700 dark:text-amber-400'}`}>
            {loan.difference === null ? 'Not known' : agrees ? 'None: the balances agree' : formatCurrency(Math.abs(loan.difference))}
          </dd>
        </div>
      </dl>
      {loan.theirs === null && (
        <p className="text-xs text-amber-700 dark:text-amber-400" role="status">
          {partnerName} has not set a loan account on this connection (or you may not see it), so there is nothing to compare yet.
        </p>
      )}
    </section>
  );
}
