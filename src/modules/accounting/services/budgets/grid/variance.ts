/**
 * Δ vs PY and Δ vs a compare version for one grid row or total (spec §6.1), in integer cents.
 * The grid components only print what this returns ("render, never compute").
 * Polarity: an income row up is favourable, an expense row up is unfavourable; no movement is
 * neither (undefined, so `varianceColor` leaves it uncoloured). The % is over |PY|; PY = 0 gives no
 * percentage (`pyZero`), never a percentage of zero.
 */
export interface RowVariance {
  dPy: number | null;
  pct: number | null;
  pyZero: boolean;
  favPy: boolean | undefined;
  dCmp: number | null;
  favCmp: boolean | undefined;
}

const favourable = (d: number | null, incomeUp: boolean): boolean | undefined =>
  d === null || d === 0 ? undefined : (d > 0) === incomeUp;

export function rowVariance(fy: number | null, pyFy: number | null, compareFy: number | null, incomeUp: boolean): RowVariance {
  const dPy = fy !== null && pyFy !== null ? fy - pyFy : null;
  const dCmp = fy !== null && compareFy !== null ? fy - compareFy : null;
  const pyZero = dPy !== null && pyFy === 0;
  const pct = dPy !== null && pyFy !== null && pyFy !== 0 ? (dPy / Math.abs(pyFy)) * 100 : null;
  return { dPy, pct, pyZero, favPy: favourable(dPy, incomeUp), dCmp, favCmp: favourable(dCmp, incomeUp) };
}
