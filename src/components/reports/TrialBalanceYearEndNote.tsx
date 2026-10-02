/**
 * The derived year-end close on a trial balance whose period crosses a
 * fiscal-year start (D4). Opening, movement and closing are the account
 * ledger's; the close bridges them — opening + movement + close = closing —
 * and is labelled the way the account-detail page labels it
 * (AccountLedgerSummary): derived, unsigned amount, direction in words.
 * Inside one fiscal year every close is 0 and nothing renders.
 */

const fmt = (n: number) =>
  new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);

/** Under one row's account name: what the derived close did to this account. */
export function YearEndCloseNote({ closed, derived }: { closed?: number; derived?: boolean }) {
  if (!closed) return null;
  // RE-BF receives the closes, so its direction is profit or loss, not "closed to".
  const text = derived
    ? `includes fiscal years closed in this period: net ${fmt(Math.abs(closed))} ${closed > 0 ? 'profit' : 'loss'}`
    : `net ${fmt(Math.abs(closed))}${closed > 0 ? ' returned from' : ' closed to'} retained earnings`;
  return (
    <span className="block text-xs italic text-[var(--ff-text-tertiary)]">
      Year-end close: {text} — derived, not posted
    </span>
  );
}

/** Below the table: why opening + movement does not equal closing on the affected rows. */
export function TrialBalanceYearEndNote({ fiscalYearEnds, broughtForwardClosed }: {
  fiscalYearEnds: string[];
  /** RE-BF's closedToRetainedEarnings — the net of every close, credit-positive. */
  broughtForwardClosed: number;
}) {
  if (fiscalYearEnds.length === 0) return null;
  const net = broughtForwardClosed === 0
    ? `net ${fmt(0)} — the closed years offset`
    : `net ${fmt(Math.abs(broughtForwardClosed))} ${broughtForwardClosed > 0 ? 'profit' : 'loss'}`;
  return (
    <p className="mt-3 text-xs text-[var(--ff-text-tertiary)]" role="note">
      This period crosses a fiscal-year start. Income-statement balances were closed to retained earnings at
      the fiscal year end {fiscalYearEnds.join(', ')} (derived — not posted; {net}), so on the affected rows
      opening + movement + year-end close = closing, as on the account ledger.
    </p>
  );
}
