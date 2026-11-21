/**
 * What one bill bills each line of one PO (cents; PR #1703 breaker r9, the corrected rule; pure). `lineNets`: per PO line, the net
 * of the bill's postings to that line. The bill bills max(0, sum of the line nets) on the PO, billAttribution's lines tie. Each line
 * with a positive net keeps it less a share of the absolute total of the negative line nets, pro rata to its positive net, by
 * largest remainder; a line netting 0 or less bills nothing. So a credit stays on the line (account) it was posted to whenever that
 * line's own net covers it, shares sum exactly to the PO figure, and no line ever bills more than its own net.
 */
export function spreadLineNets(lineNets: readonly number[]): number[] {
  const billed = Math.max(0, lineNets.reduce((s, c) => s + c, 0));
  const positive = lineNets.map((c) => Math.max(0, c));
  const total = positive.reduce((s, c) => s + c, 0);
  if (billed === 0 || total === 0) return lineNets.map(() => 0);
  // billed <= total, so each exact share billed * c / total is within [0, c].
  const exact = positive.map((c) => (BigInt(billed) * BigInt(c)));
  const shares = exact.map((x) => Number(x / BigInt(total)));
  let left = billed - shares.reduce((s, c) => s + c, 0);
  const byRemainder = exact.map((x, i) => ({ i, rem: x % BigInt(total) }))
    .filter((r) => positive[r.i]! > 0)
    .sort((a, b) => (a.rem === b.rem ? a.i - b.i : a.rem > b.rem ? -1 : 1));
  for (const r of byRemainder) {
    if (left <= 0) break;
    if (shares[r.i]! < positive[r.i]!) { shares[r.i] = shares[r.i]! + 1; left -= 1; }
  }
  return shares;
}
