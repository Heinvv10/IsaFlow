/**
 * When a financial ratio cannot be computed, and what to say about it.
 *
 * AN-07: `safeDiv` returns 0 for a zero denominator and a sign-flipped number
 * for a negative one, so every ratio dividing by equity silently produced a
 * reading for an insolvent company. Because debt-to-equity is scored
 * lower-is-better, that reading was the healthiest possible one — insolvency
 * presented as excellent gearing.
 *
 * A ratio with a non-positive denominator is not merely unusual, it is
 * arithmetically meaningless, and the honest output is no number plus a reason.
 */

/** Ratio fields whose denominator is total equity. */
export const EQUITY_DIVIDED_RATIOS = [
  'debtToEquity',
  'returnOnEquity',
  'equityMultiplier',
  'dupontLeverage',
] as const;

/**
 * Why an equity-divided ratio cannot be reported, or null if it can.
 *
 * Zero and negative equity are DIFFERENT conditions and both are fatal to the
 * arithmetic, so they share the null but not the wording. Zero means there is
 * no equity base to express anything as a proportion of. Negative means
 * liabilities exceed assets, and the sign flip inverts the ranking so that a
 * worse company scores better — which is the specific harm here.
 */
export function equityBasisFailure(totalEquity: number): string | null {
  if (totalEquity < 0) {
    return 'Equity is negative — liabilities exceed assets, so this ratio inverts and cannot be ranked.';
  }
  if (totalEquity === 0) {
    return 'There is no equity to divide by, so this ratio has no meaning.';
  }
  return null;
}

/** `{ ratioField: reason }` for every equity-divided ratio, or `{}` when equity is sound. */
export function equityNotMeaningful(totalEquity: number): Record<string, string> {
  const reason = equityBasisFailure(totalEquity);
  if (!reason) return {};
  return Object.fromEntries(EQUITY_DIVIDED_RATIOS.map((k) => [k, reason]));
}
