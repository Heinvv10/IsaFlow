/**
 * Format a number as a South African Rand string, e.g. "R 318,400.00".
 * Negative amounts render as "-R 2,300.00".
 *
 * Grouping is done manually (comma thousands, dot decimal) rather than via
 * toLocaleString — the 'en-ZA'/'af-ZA' ICU locales disagree on separators
 * across Node builds, and we want a deterministic, test-stable string.
 */

interface FormatMoneyOptions {
  /** Decimal places (default 2). */
  decimals?: number;
}

export function formatMoney(amount: number, options: FormatMoneyOptions = {}): string {
  // Non-finite inputs (NaN/Infinity) are the caller's responsibility; they pass through toFixed verbatim.
  const decimals = options.decimals ?? 2;
  const negative = amount < 0;
  const fixed = Math.abs(amount).toFixed(decimals); // e.g. "318400.00" (or "1200000" when decimals: 0)
  const [intPart, fracPart] = fixed.split('.');
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  // Gate on fracPart, not decimals: toFixed() on NaN/Infinity yields no '.', so this keeps "R NaN" clean (no ".undefined").
  const body = fracPart !== undefined ? `${grouped}.${fracPart}` : grouped;
  return `${negative ? '-' : ''}R ${body}`;
}
