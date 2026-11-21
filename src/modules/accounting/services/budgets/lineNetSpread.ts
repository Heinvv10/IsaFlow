/**
 * What one bill bills each line of one PO (cents; PR #1703 breaker r9 / r10, pure). `lineNets`: per PO line, the net of the bill's
 * postings to that line; `caps`: per line, the most it can be billed, its line_total (breaker r10 R10-1).
 *
 * The bill bills max(0, sum of the line nets) on the PO, billAttribution's lines tie. Each line with a positive net keeps it less
 * a share of the absolute total of the negative line nets, pro rata to its positive net; a line netting 0 or less bills nothing.
 * No line is given more than min(its own net, its cap): what a capped line cannot take is water-filled onto the other positive lines
 * with room left, pro rata to their positive net, round after round; what is left once every line is full is netted nowhere. So a
 * credit stays on the line (account) it was posted to whenever that line's own net covers it, an over-billed line never swallows a
 * sibling's credit, and shares sum exactly to min(the PO figure, the sum of the limits).
 *
 * Each round uses largest remainder: each line takes the floor of its exact share, and the cents left go one each to the largest
 * fractional remainders; a tie goes to the lower index (the bill's line order), so the result is deterministic.
 */
function largestRemainder(amount: number, weights: readonly number[]): number[] {
  const total = weights.reduce((s, c) => s + c, 0);
  if (amount <= 0 || total <= 0) return weights.map(() => 0);
  const exact = weights.map((w) => BigInt(amount) * BigInt(w));
  const shares = exact.map((x) => Number(x / BigInt(total)));
  let left = amount - shares.reduce((s, c) => s + c, 0);
  const order = exact.map((x, i) => ({ i, rem: x % BigInt(total) })).filter((r) => weights[r.i]! > 0)
    .sort((a, b) => (a.rem === b.rem ? a.i - b.i : a.rem > b.rem ? -1 : 1));
  for (const r of order) {
    if (left <= 0) break;
    shares[r.i] = shares[r.i]! + 1;
    left -= 1;
  }
  return shares;
}

export function spreadLineNets(lineNets: readonly number[], caps?: readonly number[]): number[] {
  const positive = lineNets.map((c) => Math.max(0, c));
  const limit = positive.map((c, i) => Math.min(c, Math.max(0, caps?.[i] ?? c)));
  let left = Math.min(Math.max(0, lineNets.reduce((s, c) => s + c, 0)), limit.reduce((s, c) => s + c, 0));
  const shares = lineNets.map(() => 0);
  // Each round spreads what is left over the lines still under their limit, by positive net; a share above a line's room is cut to
  // it and the cut goes round again. At least one line fills, or everything is placed, each round.
  while (left > 0) {
    const weights = positive.map((c, i) => (shares[i]! < limit[i]! ? c : 0));
    if (weights.every((w) => w === 0)) break;
    const round = largestRemainder(left, weights);
    round.forEach((c, i) => {
      const take = Math.min(c, limit[i]! - shares[i]!);
      shares[i] = shares[i]! + take;
      left -= take;
    });
  }
  return shares;
}
