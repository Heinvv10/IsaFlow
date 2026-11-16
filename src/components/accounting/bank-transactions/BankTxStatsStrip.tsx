/**
 * BankTxStatsStrip — the selected account's statement panel and line tiles, full width directly above the tabs,
 * all from the bank-account summary (WP1 PR-C).
 *
 * Allocated + Suggested + Unallocated + Excluded = the account's posted lines (`data-posted-lines`, which the golden
 * path and the tests sum against). "Awaiting review" is a different cut (the New tab's posted lines), so it is an
 * outlined tile of its own and not part of that sum.
 */

import { BankStatementPanel } from './BankStatementPanel';
import type { BankAccountSummary } from './useBankTxSummary';

interface Props {
  bank: BankAccountSummary;
  /** The list total while the New tab is open with filters narrowing it, else null. */
  shown: number | null;
  /** Opens the Provisional tab. */
  onShowProvisional: () => void;
}

function Stat({ value, label, className, testid, children }: {
  value: number; label: string; className: string; testid: string; children?: React.ReactNode;
}) {
  return (
    <div data-testid={testid} className="min-w-[6.5rem] rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-primary)] px-4 py-3">
      <p className={`text-2xl font-bold tabular-nums ${className}`}>{value}</p>
      <p className="text-xs text-[var(--ff-text-secondary)]">{label}</p>
      {children}
    </div>
  );
}

export function BankTxStatsStrip({ bank, shown, onShowProvisional }: Props) {
  const c = bank.counts;
  return (
    <div data-testid="bank-tx-stats-strip" data-posted-lines={c.posted} className="mt-4 flex flex-wrap items-stretch gap-4">
      <div className="w-full sm:w-[360px] shrink-0">
        <BankStatementPanel bank={bank} />
      </div>
      <div className="flex min-w-0 flex-1 flex-col justify-center gap-3">
        <p className="truncate text-sm text-[var(--ff-text-secondary)]" title={bank.accountName}>
          <span className="font-semibold text-[var(--ff-text-primary)]">{bank.accountName}</span>
          <span className="ml-2 font-id text-xs">{bank.accountCode}</span>
        </p>
        <div className="flex flex-wrap gap-3">
          <Stat testid="tile-allocated" value={c.allocated} label="Allocated" className="text-teal-700 dark:text-teal-400">
            {c.provisional > 0 && (
              <button type="button" onClick={onShowProvisional} data-testid="tile-provisional-link"
                title="List the provisional lines"
                className="mt-0.5 text-xs text-teal-700 dark:text-teal-400 underline hover:no-underline">
                incl. {c.provisional} provisional
              </button>
            )}
          </Stat>
          <Stat testid="tile-suggested" value={c.suggested} label="Suggested" className="text-sky-700 dark:text-sky-400" />
          <Stat testid="tile-unallocated" value={c.unallocated} label="Unallocated" className="text-amber-700 dark:text-amber-400" />
          <Stat testid="tile-excluded" value={c.excluded} label="Excluded" className="text-[var(--ff-text-primary)]" />
          <div data-testid="tile-awaiting-review"
            className="min-w-[6.5rem] rounded-lg border-2 border-dashed border-[var(--ff-border-light)] px-4 py-3">
            <p className="text-2xl font-bold tabular-nums text-[var(--ff-text-primary)]">{c.awaitingReview}</p>
            <p className="text-xs text-[var(--ff-text-secondary)]">Awaiting review</p>
            {shown !== null && <p data-testid="tile-awaiting-shown" className="text-xs text-[var(--ff-text-tertiary)]">{shown} shown</p>}
            {c.pendingAtBank > 0 && <p data-testid="tile-pending-at-bank" className="text-xs text-[var(--ff-text-tertiary)]">+{c.pendingAtBank} pending at bank</p>}
          </div>
        </div>
      </div>
    </div>
  );
}
