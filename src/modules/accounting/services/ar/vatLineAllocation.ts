/**
 * Make a printed per-line VAT column foot to the VAT total printed beneath it.
 *
 * A tax invoice states one VAT total, and the column above it must add up to
 * that number. Deriving each line's VAT independently (`amount × rate`, rounded
 * to the cent) does not: seven lines of R14.29 at 15% each round to R2.14, so
 * the column sums to R14.98 while the stored header aggregate for the same
 * R100.03 subtotal is R15.00. Two cents, on a document SARS reads.
 *
 * The header aggregate is the authoritative figure — it is what `total_amount`,
 * the AR ledger and every payment allocation are built on — so it is the one
 * that stays, and the LINES are fitted to it: each line takes its natural share
 * (`amount × rate`), and the residual left by rounding is handed to the lines
 * with the largest fractional part first. Every line's VAT stays within a cent
 * of its own rate, a zero-rated line stays at zero because its weight is zero,
 * and the column sums to the header exactly.
 *
 * When no line carries a rate at all but the header still states VAT, there is
 * nothing to attribute it to. That is a real disagreement in the data, not a
 * rounding artefact, so it is returned as `unattributed` for the caller to print
 * and log rather than being spread over zero-rated lines — which would print VAT
 * against a line the same page labels 0%.
 */

export interface VatAllocation {
  /** One VAT amount per weight, in the same order. Sums to `headerVat − unattributed`. */
  lineVats: number[];
  /** Header VAT that no line could carry. 0 in every ordinary document. */
  unattributed: number;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * @param headerVat  the stored VAT total, in rands.
 * @param weights    each line's own `amount × rate / 100`, in rands, unrounded.
 */
export function allocateVatToLines(headerVat: number, weights: number[]): VatAllocation {
  const target = Math.round(headerVat * 100);
  if (weights.length === 0) {
    return { lineVats: [], unattributed: round2(headerVat) };
  }

  const weightTotal = weights.reduce((sum, w) => sum + w, 0);
  if (weightTotal === 0) {
    return { lineVats: weights.map(() => 0), unattributed: round2(headerVat) };
  }

  // Cents each line is entitled to, floored, plus the fractional remainder that
  // decides who gets the leftover cents.
  const exact = weights.map((w) => (w / weightTotal) * target);
  const cents = exact.map((c) => Math.floor(c));
  let remaining = target - cents.reduce((sum, c) => sum + c, 0);

  const order = exact
    .map((c, index) => ({ index, fraction: c - Math.floor(c) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);

  // `Math.floor` always rounds DOWN, negative targets included, so the floors
  // never overshoot and `remaining` is always a non-negative count of cents —
  // fewer than one per line.
  for (let i = 0; remaining > 0; i += 1) {
    cents[order[i % order.length]!.index]! += 1;
    remaining -= 1;
  }

  return { lineVats: cents.map((c) => c / 100), unattributed: 0 };
}
