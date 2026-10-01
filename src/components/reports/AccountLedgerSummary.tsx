/**
 * AccountLedgerSummary
 * Three-column strip: Opening Balance | Movement for period | Closing Balance.
 * Uses server-returned period totals (not a client-side reduce over the paginated slice).
 */

const fmt = (n: number) =>
  new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);

interface Props {
  openingBalance: number;
  /** Movement for the period (posted lines, FULL date range) — equals the statement line. */
  periodNet: number;
  /** Derived year-end closes inside the range (income-statement accounts only; else 0). */
  closedToRetainedEarnings: number;
  /** How many derived year-end close rows there are (the net can be zero while closes exist). */
  closedYears: number;
  /** Opening + periodNet + closedToRetainedEarnings — the balance as at the range end. */
  periodClosingBalance: number;
  /** Number of posted journal lines in the range (derived close rows excluded), for the label. */
  total: number;
}

export function AccountLedgerSummary({
  openingBalance,
  periodNet,
  closedToRetainedEarnings,
  closedYears,
  periodClosingBalance,
  total,
}: Props) {
  return (
    <div className="grid grid-cols-3 divide-x divide-[var(--ff-border-light)] border-b border-[var(--ff-border-light)]">
      <div className="px-6 py-3">
        <p className="text-xs text-[var(--ff-text-tertiary)]">Opening Balance</p>
        <p className="font-mono font-medium text-[var(--ff-text-primary)]">
          {fmt(openingBalance)}
        </p>
      </div>
      <div className="px-6 py-3">
        <p className="text-xs text-[var(--ff-text-tertiary)]">
          Movement for period ({total.toLocaleString()} rows)
        </p>
        <p className="font-mono font-medium text-[var(--ff-text-primary)]">
          {fmt(periodNet)}
          <span className="text-xs text-[var(--ff-text-tertiary)] ml-1">net</span>
        </p>
      </div>
      <div className="px-6 py-3">
        <p className="text-xs text-[var(--ff-text-tertiary)]">Closing Balance</p>
        <p className="font-mono font-medium text-[var(--ff-text-primary)]">
          {fmt(periodClosingBalance)}
        </p>
        {closedYears > 0 && (
          <p className="text-xs text-[var(--ff-text-tertiary)]">
            {/* closedToRetainedEarnings is the negated NET of the normal-side balances closed: show it unsigned, direction in words. */}
            {closedYears} year-end close{closedYears === 1 ? '' : 's'} (derived):{' '}
            {closedToRetainedEarnings === 0
              ? `net ${fmt(0)} — the closed years offset`
              : `net ${fmt(Math.abs(closedToRetainedEarnings))}${closedToRetainedEarnings > 0 ? ' returned from' : ' closed to'} retained earnings`}
          </p>
        )}
      </div>
    </div>
  );
}
