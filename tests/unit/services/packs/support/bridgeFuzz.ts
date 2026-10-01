/**
 * The reviewer's bridge generator (round 9, `bridge9v3.ts`), by seed: whole
 * rands from a thousand to a billion, in the shapes a ledger produces and the
 * ones that break a chart — one bar, all nil, tiny movements on a large
 * balance, nine-digit figures on narrow bars, a subtotal mid-bridge.
 */
import type { WaterfallStep } from '@/modules/accounting/services/reports/waterfallDataService';

const NAMES = ['Revenue', 'Cost of sales', 'Operating Expenses', 'Other income', 'Depreciation', 'Receipts from customers',
  'Payments to suppliers', 'Tax paid', 'Capex', 'Other, not separately captured', 'Unexplained movement', 'Loans raised'];
const FAMILIES = ['random', 'random', 'random', 'mixed', 'allNeg', 'allPos', 'tiny', 'alternating', 'wideNarrow',
  'wideNarrow', 'single', 'zero', 'midSubtotal'] as const;

export interface Fuzz { rnd: () => number; pick: <T>(from: readonly T[]) => T; next: () => { family: string; steps: WaterfallStep[] } }

export function bridgeFuzz(seedValue: number): Fuzz {
  let seed = seedValue;
  const rnd = () => (seed = (seed * 16_807) % 2_147_483_647) / 2_147_483_647;
  const pick = <T>(from: readonly T[]): T => from[Math.floor(rnd() * from.length)]!;
  const many = (n: number, of: (i: number) => number) => Array.from({ length: n }, (_, i) => of(i));
  const bridgeFrom = (open: number, moves: number[]): WaterfallStep[] => {
    const steps: WaterfallStep[] = [{ label: 'Opening', start: 0, end: open, value: open, isSubtotal: true, color: 'blue' }];
    let running = open;
    moves.forEach((move, i) => {
      const label = rnd() < 0.5 ? pick(NAMES) : `Movement ${i + 1}`;
      steps.push({ label, start: running, end: running + move, value: move, isSubtotal: false, color: move >= 0 ? 'green' : 'red' });
      running += move;
    });
    steps.push({ label: 'Closing', start: 0, end: running, value: running, isSubtotal: true, color: 'teal' });
    return steps;
  };
  const next = () => {
    const family = pick(FAMILIES);
    const mag = Math.pow(10, 3 + rnd() * 6);
    const v = () => Math.round((rnd() - 0.5) * 2 * mag);
    const n = 1 + Math.floor(rnd() * 8);
    switch (family) {
      case 'mixed': return { family, steps: bridgeFrom(v(), many(n, () => Math.round(v() * (rnd() < 0.5 ? 0.01 : 1)))) };
      case 'allNeg': return { family, steps: bridgeFrom(-Math.abs(v()), many(n, () => -Math.abs(v()))) };
      case 'allPos': return { family, steps: bridgeFrom(Math.abs(v()), many(n, () => Math.abs(v()))) };
      case 'tiny': { const o = v() || 1000; return { family, steps: bridgeFrom(o, many(n, () => Math.round(o * (rnd() - 0.5) * 0.01))) }; }
      case 'alternating': { const a = Math.abs(v()) || 1; return { family, steps: bridgeFrom(v(), many(n, (i) => Math.round((i % 2 ? -a : a) * (0.5 + rnd())))) }; }
      case 'wideNarrow': {
        const m = Math.pow(10, 7 + rnd() * 2);
        const w = () => Math.round((rnd() - 0.5) * 2 * m);
        return { family, steps: bridgeFrom(w() * (rnd() < 0.3 ? 5 : 1), many(4 + Math.floor(rnd() * 5), () => Math.round(w() * (rnd() < 0.35 ? 0.03 : 1)))) };
      }
      case 'single': { const x = v(); return { family, steps: [{ label: 'Revenue', start: 0, end: x, value: x, isSubtotal: rnd() < 0.5, color: x >= 0 ? 'green' : 'red' }] as WaterfallStep[] }; }
      case 'zero': return { family, steps: bridgeFrom(0, many(n, () => 0)) };
      case 'midSubtotal': {
        const steps = bridgeFrom(Math.abs(v()), many(Math.max(2, n), () => Math.round(v() * 0.4)));
        const k = 2 + Math.floor(rnd() * (steps.length - 3));
        const at = steps[k - 1]!.end;
        steps.splice(k, 0, { label: 'Gross Profit', start: 0, end: at, value: at, isSubtotal: true, color: 'teal' });
        return { family, steps };
      }
      default: return { family, steps: bridgeFrom(Math.round(v() * (rnd() < 0.15 ? 0 : 1)), many(n, () => Math.round(v() * (rnd() < 0.4 ? 0.02 : 1)))) };
    }
  };
  return { rnd, pick, next };
}
