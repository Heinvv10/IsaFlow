/**
 * AccountLedgerSummary
 * Three-column strip: Opening Balance | Period Net | Period Closing Balance.
 * Uses server-returned period totals (not a client-side reduce over the paginated slice).
 */

const fmt = (n: number) =>
  new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);

interface Props {
  openingBalance: number;
  /** Sum of (debits − credits) over the FULL date range from the server. */
  periodNet: number;
  /** Opening + periodNet, computed server-side over the full range. */
  periodClosingBalance: number;
  /** Total number of transactions (for the label). */
  total: number;
}

export function AccountLedgerSummary({
  openingBalance,
  periodNet,
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
          Transactions ({total.toLocaleString()}) — period net
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
      </div>
    </div>
  );
}
