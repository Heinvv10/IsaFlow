/**
 * The date window of a parsed statement, for the agent import's dedup read
 * (bankStatementImportService): the earliest and latest REAL calendar day
 * among its lines, or null when not one line carries one.
 */
import type { ParsedBankTransaction } from '../../types/bank.types';

/**
 * The shape check is not enough on its own: the OFX and MT940 parsers only
 * reject day > 31, so `<DTPOSTED>20260231` becomes the well-formed but
 * non-existent '2026-02-31'. Interpolated into `${from}::DATE` that raises
 * SQLSTATE 22008 on the request connection, aborting the surrounding
 * transaction and surfacing as a generic failure instead of a usable message.
 * Round-tripping through Date catches it here, where we can say what is wrong.
 */
function isRealCalendarDate(d: string): boolean {
  const [y, m, day] = d.slice(0, 10).split('-').map(Number);
  if (!y || !m || !day) return false;
  const probe = new Date(Date.UTC(y, m - 1, day));
  return probe.getUTCFullYear() === y
    && probe.getUTCMonth() === m - 1
    && probe.getUTCDate() === day;
}

export function dateRangeOf(txs: ParsedBankTransaction[]): { from: string; to: string } | null {
  const dates = txs
    .map((t) => t.transactionDate)
    .filter((d): d is string =>
      typeof d === 'string' && /^\d{4}-\d{2}-\d{2}/.test(d) && isRealCalendarDate(d))
    .sort();
  const from = dates[0];
  const to = dates[dates.length - 1];
  return from && to ? { from, to } : null;
}
