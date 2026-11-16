/**
 * ToCodeLine — the card's third line: "N to code · in R… / out −R…" in amber while any line is still to code
 * (suggested + unallocated), else "All coded". The warning keys on the COUNT, never on a net amount: a +R100 and a
 * −R100 line net to R0.00 and are still two lines to code (WP1, PR-C).
 */
import { fmtCents } from './bankCents';

interface Props {
  toCode: number;
  inCents: number;
  outCents: number;
  /** Group cards say "across this group" in the tooltip. */
  scope?: string;
}

export function ToCodeLine({ toCode, inCents, outCents, scope = '' }: Props) {
  if (toCode === 0) {
    return <span data-testid="card-all-coded" className="text-xs text-teal-700 dark:text-teal-400">All coded</span>;
  }
  return (
    <span data-testid="card-to-code" title={`${toCode} line${toCode !== 1 ? 's' : ''} still to code${scope}`}
      className="text-xs text-amber-700 dark:text-amber-400 tabular-nums">
      {toCode} to code · in {fmtCents(inCents)} / out {fmtCents(outCents)}
    </span>
  );
}
