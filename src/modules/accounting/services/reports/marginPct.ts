/**
 * One margin definition.
 *
 * There were four: `incomeStatementService` (null on no revenue),
 * `reportPackService` (0, rounded to two decimals), `kpiDashboardService` (0,
 * unrounded) and `afsKpiService` (0, via safeDiv). Four answers to "what is
 * the gross margin" is how a reader gets a different percentage off two
 * screens showing the same period.
 *
 * `null` when there is no revenue: a margin on no turnover is undefined, not
 * zero. Callers that must keep emitting 0 do it at their own call site with
 * `?? 0`, so this function never has to know which of them wants which.
 */
export function marginPct(numerator: number, revenue: number): number | null {
  if (!Number.isFinite(numerator) || !Number.isFinite(revenue) || revenue === 0) return null;
  const pct = (numerator / revenue) * 100;
  return Number.isFinite(pct) ? pct : null;
}

/** `marginPct` to two decimals — the rounding the report pack prints. */
export function marginPct2dp(numerator: number, revenue: number): number | null {
  const pct = marginPct(numerator, revenue);
  return pct === null ? null : Math.round(pct * 100) / 100;
}
