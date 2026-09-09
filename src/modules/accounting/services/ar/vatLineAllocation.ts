/**
 * Make a printed per-line VAT column foot to the VAT total printed beneath it.
 *
 * A tax invoice states one VAT total, and the column above it must add up to
 * that number. Deriving each line's VAT independently (`amount × rate`, rounded
 * to the cent) does not: seven lines of R14.29 at 15% each round to R2.14, so
 * the column sums to R14.98 while the stored header aggregate for the same
 * R100.03 subtotal is R15.00. Two cents, on a document SARS reads.
 *
 * Two cents is the whole size of the problem, and the fix must not be larger
 * than it. Each line keeps its OWN VAT (`amount × rate`, rounded to the cent),
 * and only the residual left by that rounding is moved — one cent at a time, to
 * the lines whose rounding lost the most — so no line ever drifts more than a
 * cent from the VAT its own printed rate produces.
 *
 * That bound is what makes the residual meaningful. A residual larger than a
 * cent per rated line is not rounding: it is the header stating VAT the lines
 * cannot account for — a R100 line at 15% under a R30 header, the drift the
 * conversion paths produce. Spreading that across the lines would print 30% VAT
 * against a line labelled 15% and the column would foot on a lie. So it is
 * returned as `unattributed` for the caller to PRINT and log, and the column
 * plus the disclosure is what foots to the header.
 *
 * The same bound is what keeps mixed-sign lines sane. Sharing the header out in
 * proportion to `Σ weights` explodes when a discount or return line nearly
 * cancels a positive one (`hdr=15, weights=[100, −99.999999]` allocated
 * R1,500,000,003.79 against R100), because the divisor goes to zero while the
 * weights do not. Nothing here divides by that sum.
 */

export interface VatAllocation {
  /** One VAT amount per weight, in the same order. Sums to `headerVat − unattributed`. */
  lineVats: number[];
  /** Header VAT that no line's own rate can carry. 0 in every ordinary document. */
  unattributed: number;
}

/**
 * @param headerVat  the stored VAT total, in rands.
 * @param weights    each line's own `amount × rate / 100`, in rands, unrounded.
 */
export function allocateVatToLines(headerVat: number, weights: number[]): VatAllocation {
  const target = Math.round(headerVat * 100);
  const exact = weights.map((w) => w * 100);
  const cents = exact.map((c) => Math.round(c));

  // Cents the header holds over and above what the lines' own rates produce.
  let remaining = target - cents.reduce((sum, c) => sum + c, 0);

  // Only a RATED line can absorb a cent — moving one onto a zero-rated line
  // prints VAT against a line the same page labels 0%. With no rated line at
  // all (or none at all), the tolerance is zero and the whole header is
  // disclosed rather than spread over lines that cannot carry it.
  const absorbers = exact
    .map((c, index) => ({ index, drift: c - cents[index]! }))
    .filter((l) => exact[l.index] !== 0);

  if (Math.abs(remaining) <= absorbers.length) {
    // Rounding, not disagreement. Hand the cents to the lines that lost the
    // most to rounding (or, when taking cents back, to those that gained most).
    absorbers.sort((a, b) =>
      remaining > 0 ? b.drift - a.drift || a.index - b.index
                    : a.drift - b.drift || a.index - b.index);
    const step = remaining > 0 ? 1 : -1;
    for (let i = 0; remaining !== 0; i += 1) {
      cents[absorbers[i]!.index]! += step;
      remaining -= step;
    }
  }

  return { lineVats: cents.map((c) => c / 100), unattributed: remaining / 100 };
}
