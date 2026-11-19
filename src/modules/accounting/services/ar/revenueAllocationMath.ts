/**
 * The pure allocation maths behind invoiceRevenueLines (split out of it for the 300-line cap, unchanged; it
 * re-exports both): splitting an amount in cents over weights, and a credit note's capped share of each leg.
 */

/**
 * `total` (an integer, cents) split in proportion to `weights`, each share
 * rounded to the cent; the rounding residual is then placed one cent at a
 * time, largest weight first (the first on a tie), so no share moves more than
 * a cent from its rounded value — the whole residual on one share turned a 1c
 * credit into a 49c debit (100 tiny lines that do not foot, review #685). The
 * shares always sum to `total`. Weights must sum to more than zero.
 */
export function allocateByWeight(total: number, weights: readonly number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  // The residual loop below never ends on NaN; a hang would hold the invoice's locks.
  if (!(sum > 0) || !Number.isFinite(total)) throw new Error(`allocateByWeight: cannot split ${total} over weights summing to ${sum}`);
  const shares = weights.map((w) => Math.round((total * w) / sum));
  const order = weights.map((_, i) => i).sort((a, b) => Math.abs(weights[b]!) - Math.abs(weights[a]!) || a - b);
  let residual = total - shares.reduce((a, b) => a + b, 0);
  for (let k = 0; residual !== 0; k++) {
    const i = order[k % order.length]!;
    const step = Math.sign(residual);
    shares[i] = shares[i]! + step;
    residual -= step;
  }
  return shares;
}

/**
 * One note's share of each leg (cents): pro rata to what each leg still
 * carries, then clamped to it — that caps a note larger than what is left, and
 * the rounding cent that can push a leg past it (it takes ten legs:
 * allocateByWeight hands the residual to the largest weight).
 */
export function noteShares(carries: readonly number[], total: number): number[] {
  const carried = carries.reduce((a, b) => a + b, 0);
  return (carried <= 0 ? carries.map(() => 0) : allocateByWeight(total, carries)).map((share, i) => {
    const cap = carries[i]!;
    return cap >= 0 ? Math.min(share, cap) : Math.max(share, cap);
  });
}
