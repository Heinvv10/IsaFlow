/**
 * The two arithmetic helpers the reconciliation shares.
 *
 * Rounding happens ONCE, at presentation, on a value summed at full precision.
 * Rounding each part first manufactures cents of difference between sums that
 * were equal, which on a reconciliation reads as a finding and is not one.
 */

export function round2(value: number): number {
  // +0 rather than -0: a difference of -0 renders as "-0" in JSON and reads
  // to a human as a sign error on a reconciliation that actually balanced.
  const r = Math.round(value * 100) / 100;
  return r === 0 ? 0 : r;
}

/** The later of two ISO-8601 timestamps, either of which may be absent. */
export function laterOf(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a > b ? a : b;
}
