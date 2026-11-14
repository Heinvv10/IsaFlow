/**
 * Split an undo-share amount over a bill's posting legs, pro rata, in whole cents (step 6).
 *
 * Each leg gets `amount × leg / Σlegs` rounded half up — except ONE remainder leg, which takes whatever makes the
 * legs sum to the amount exactly ("last-leg remainder"). The remainder leg is the LARGEST non-VAT leg (the first of
 * equals), where a cent distorts least, so the VAT Input leg is always the rounded pro-rata figure and a cent of
 * rounding never lands in the VAT201; a bill with no other leg puts it on its last leg. A full settlement
 * (amount = Σlegs) reproduces every leg exactly.
 *
 * Rounding every other leg up can overshoot when there are many tiny legs (four 1c legs, 2c to split), which would
 * leave the remainder leg negative; then the other legs are floored instead, which can never overshoot.
 * BigInt because cents × cents passes 2^53 well inside NUMERIC(15,2).
 */
export interface SplitLeg {
  cents: number;
  isVat: boolean;
}

export function splitOverLegs(amountCents: number, legs: readonly SplitLeg[]): number[] {
  const base = legs.reduce((s, l) => s + l.cents, 0);
  if (legs.length === 0 || base <= 0 || legs.some((l) => l.cents < 0)) {
    throw new RangeError('A bill share can only be split over positive posting legs.');
  }
  if (amountCents > base) {
    throw new RangeError(`Cannot split ${amountCents}c over legs of ${base}c: the amount is more than the bill.`);
  }
  let remainderAt = -1;
  legs.forEach((l, i) => { if (!l.isVat && (remainderAt < 0 || l.cents > legs[remainderAt]!.cents)) remainderAt = i; });
  if (remainderAt < 0) remainderAt = legs.length - 1;

  const amount = BigInt(amountCents);
  const total = BigInt(base);
  const share = (cents: number, roundHalfUp: boolean): number => {
    const num = amount * BigInt(cents);
    return Number(roundHalfUp ? (2n * num + total) / (2n * total) : num / total);
  };
  for (const roundHalfUp of [true, false]) {
    const out = legs.map((l, i) => (i === remainderAt ? 0 : share(l.cents, roundHalfUp)));
    const rest = amountCents - out.reduce((s, c) => s + c, 0);
    if (rest >= 0) {
      out[remainderAt] = rest;
      return out;
    }
  }
  // Unreachable: floored shares never sum past the amount.
  throw new RangeError('Could not split the share over the bill legs.');
}
