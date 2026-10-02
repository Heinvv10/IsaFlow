/**
 * A REAL FIGURE TOO SMALL FOR ITS PRECISION, STATED AS A BOUND.
 *
 * Velocity Fibre's cash ratio of 0.0034 printed as nil on a board pack — the
 * two-place figure is `0.00`, and a reader takes `0.00×` and the dash alike
 * as "no cash". `formatMoney` already states an amount below its scale as
 * `<1`; a ratio, a day count and a percentage level now say the same thing
 * in their own unit: `<0.01`, `<1 day`, `<0.1%`, bracketed where negative.
 * A measured zero is not below its precision and keeps its zero.
 *
 * Null where the figure prints as itself.
 */
export function belowPrecision(n: number, dp: number, unit: string): string | null {
  if (n === 0 || Number(Math.abs(n).toFixed(dp)) !== 0) return null;
  const bound = `<${dp === 0 ? '1' : `0.${'0'.repeat(dp - 1)}1`}${unit}`;
  return n < 0 ? `(${bound})` : bound;
}
