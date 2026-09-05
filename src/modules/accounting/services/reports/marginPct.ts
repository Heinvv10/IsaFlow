/**
 * One margin definition.
 *
 * There were four: `incomeStatementService` (null on no revenue),
 * `reportPackService` (0, rounded to two decimals), `kpiDashboardService` (0,
 * unrounded) and `afsKpiService` (0, via safeDiv). Four answers to "what is
 * the gross margin" is how a reader gets a different percentage off two
 * screens showing the same period.
 *
 * `null` when there is no turnover to take a margin OF. By default that means
 * `revenue <= 0`: a margin on negative turnover — credit notes or reversals
 * exceeding sales, which unguarded SQL sums reach — divides a loss by a
 * negative and prints a healthy-looking POSITIVE percentage, which the AFS RAG
 * bands would then colour green.
 *
 * `allowNegativeRevenue` opts out, and exists only to hold two pre-existing
 * behaviours still: `afsKpiService` and `incomeStatementService` both guarded
 * `revenue === 0` and computed through a negative. Converging them is a
 * behaviour change to a live figure and belongs in its own change, not in a
 * refactor whose contract is that no service's numbers move.
 *
 * Callers that must keep emitting 0 rather than null do it at their own call
 * site with `?? 0`, so this function never has to know which of them wants
 * which.
 */
export interface MarginOptions {
  /** Compute through a negative revenue instead of returning null. */
  allowNegativeRevenue?: boolean;
}

export function marginPct(numerator: number, revenue: number, opts: MarginOptions = {}): number | null {
  if (!Number.isFinite(numerator) || !Number.isFinite(revenue)) return null;
  if (revenue === 0) return null;
  if (revenue < 0 && !opts.allowNegativeRevenue) return null;
  const pct = (numerator / revenue) * 100;
  return Number.isFinite(pct) ? pct : null;
}

/** `marginPct` to two decimals — the rounding the report pack prints. */
export function marginPct2dp(numerator: number, revenue: number, opts: MarginOptions = {}): number | null {
  const pct = marginPct(numerator, revenue, opts);
  return pct === null ? null : Math.round(pct * 100) / 100;
}
