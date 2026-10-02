/**
 * The reviewer's figure sets for a GROWN bridge (round 12, `grow.ts`), by
 * seed: page 6's profit figures and page 8's cash figures in the shapes that
 * move an axis when the box grows — losses, a long tail of other expenses, a
 * large plug, near-equal lines, a thin margin, negative revenue, nil lines,
 * an overdraft, a flat year.
 */
import type { PackFigureSet } from '@/modules/accounting/services/packs/figures/packFigureSet';
import { figures } from '../fixtures/boardPackInputs';

const PROFIT_FAMILIES = ['plain', 'plain', 'loss', 'lossTail', 'bigPlug', 'nearEqual', 'thin', 'negRev', 'nilLines'] as const;
const CASH_FAMILIES = ['plain', 'plain', 'overdraft', 'nearEqual', 'flat'] as const;

export function growFuzz(seedValue: number) {
  let s = seedValue >>> 0;
  // mulberry32, as the reviewer's harness has it, so a seed is the same set.
  const rnd = () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const U = (a: number, b: number) => a + (b - a) * rnd();
  const logU = (a: number, b: number) => Math.exp(U(Math.log(a), Math.log(b)));
  const pick = <T>(from: readonly T[]): T => from[Math.floor(rnd() * from.length)]!;
  const r2 = (x: number) => Math.round(x * 100) / 100;
  const jit = (x: number, by = 0.03) => x * (1 + U(-by, by));

  /** Page 6's figures; no comparative, as the bridge reads none. */
  const profit = (plug: boolean): { family: string; set: PackFigureSet } => {
    const rev = r2(logU(1e5, 2e9));
    const family = pick(PROFIT_FAMILIES);
    let cos = rev * U(0.05, 0.85); let opex = rev * U(0.02, 0.6);
    let oi = rnd() < 0.4 ? 0 : rev * U(0, 0.12); let oe = rnd() < 0.4 ? 0 : rev * U(0, 0.12);
    let pl = plug ? rev * U(-0.3, 0.3) : 0; let sign = 1;
    if (family === 'loss') { cos = rev * U(0.3, 0.9); opex = rev * U(0.3, 1.3); }
    if (family === 'lossTail') { cos = rev * U(0.2, 0.7); opex = rev * U(0.2, 0.5); oe = rev * U(0.3, 1.6); }
    if (family === 'bigPlug' && plug) pl = -rev * U(0.2, 1.4);
    if (family === 'nearEqual') { const b = rev * U(0.12, 0.33); cos = jit(b); opex = jit(b); oi = jit(b); oe = jit(b); if (plug) pl = -jit(b); }
    if (family === 'thin') { cos = rev * U(0.96, 1.0); opex = rev * U(0, 0.03); oi = rev * U(0, 0.03); oe = rev * U(0, 0.03); if (plug) pl = -rev * U(0.005, 0.03); }
    if (family === 'negRev') sign = -1;
    if (family === 'nilLines') { if (rnd() < 0.5) cos = 0; if (rnd() < 0.5) opex = 0; if (rnd() < 0.5) oi = 0; if (rnd() < 0.5) oe = 0; }
    const f = { revenue: sign * rev, costOfSales: r2(sign * cos), operatingExpenses: r2(opex), otherIncome: r2(oi), otherExpenses: r2(oe), netProfit: 0 };
    f.netProfit = r2(f.revenue - f.costOfSales - f.operatingExpenses + f.otherIncome - f.otherExpenses + (plug ? (Math.abs(pl) < 1 ? 5000 : pl) : 0));
    return { family, set: { current: figures({ ...f, operatingProfit: undefined }), prior: null } as PackFigureSet };
  };

  /** Page 8's figures: an opening balance, the captured flows, a residual. */
  const cash = (plug: boolean): { family: string; set: PackFigureSet } => {
    const mag = logU(1e4, 2e9);
    const family = pick(CASH_FAMILIES);
    let open = r2(mag * U(-0.2, 1)); let op = mag * U(-1, 1);
    let inv: number | undefined = rnd() < 0.85 ? mag * U(-0.6, 0.2) : undefined;
    let fin: number | undefined = rnd() < 0.85 ? mag * U(-0.6, 0.6) : undefined;
    let residual = plug ? mag * U(-0.5, 0.5) : 0;
    if (family === 'overdraft') { open = r2(mag * U(0.02, 0.5)); op = mag * U(-0.2, 0.3); inv = rnd() < 0.7 ? -mag * U(0, 0.3) : undefined; fin = -mag * U(0.6, 2); }
    if (family === 'nearEqual') { const b = mag * U(0.2, 0.5); const sg = () => (rnd() < 0.5 ? -1 : 1); open = r2(jit(b) * sg()); op = jit(b) * sg(); inv = jit(b) * sg(); fin = jit(b) * sg(); if (plug) residual = jit(b) * sg(); }
    if (family === 'flat') { open = r2(mag); op = mag * U(-0.01, 0.01); inv = mag * U(-0.01, 0.01); fin = mag * U(-0.01, 0.01); if (plug) residual = mag * U(-0.01, 0.01); }
    let investingCashFlow: number | undefined; let capitalExpenditure: number | undefined;
    if (inv !== undefined) { if (rnd() < 0.5) investingCashFlow = r2(inv); else capitalExpenditure = r2(-inv); }
    const financingCashFlow = fin === undefined ? undefined : r2(fin);
    const res = plug ? (Math.abs(r2(residual)) < 1 ? 1234.5 : r2(residual)) : 0;
    const cashAtEnd = r2(open + r2(op) + (inv === undefined ? 0 : r2(inv)) + (fin === undefined ? 0 : r2(fin)) + res);
    return {
      family,
      set: {
        current: figures({ operatingCashFlow: r2(op), investingCashFlow, capitalExpenditure, financingCashFlow, cash: cashAtEnd }),
        prior: figures({ cash: open }),
      } as PackFigureSet,
    };
  };

  return { profit, cash };
}
