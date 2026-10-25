/**
 * The reviewer's bridge generators (round 10, `fuzzA.ts`), by seed, and the
 * arguments the pack's two callers really pass a bridge.
 *
 * Three shapes: the PROFIT bridge as `buildProfitWaterfall` builds it, the
 * CASH bridge (opening, operating, investing, financing, sometimes a plug,
 * closing), and RANDOM bridges in the shapes that break a chart — one bar,
 * all nil, tiny movements on a large balance, a subtotal mid-bridge.
 */
import { buildProfitWaterfall, type WaterfallStep } from '@/modules/accounting/services/reports/waterfallDataService';
import { axisDomain } from '@/modules/accounting/services/packs/packChartAxes';
import { svgBoxFor, svgBoxPx } from '@/modules/accounting/services/packs/pages/packChartBox';
import { BRIDGE_RUNGS, CHART_MEASURE_MM, HALF } from '@/modules/accounting/services/packs/pages/packChartRungs';
import { intervalsFor, isCompact } from '@/modules/accounting/services/packs/pages/packWaterfallBars';
import { formatStatementFigure, inProse } from '@/lib/format/money';

const NAMES = ['Revenue', 'Cost of Sales', 'Operating Expenses', 'Other Income', 'Depreciation', 'Receipts from customers',
  'Payments to suppliers', 'Tax paid', 'Capital expenditure', 'Unexplained movement', 'Loans raised', 'Dividends'];
const FAMILIES = ['random', 'random', 'mixed', 'allNeg', 'allPos', 'tiny', 'alternating', 'single', 'zero', 'midSubtotal'] as const;

export interface PrintCase {
  steps: WaterfallStep[];
  plot: { widthMm: number; heightMm: number };
  /** `waterfallOption`'s arguments after the steps, scale and palette. */
  ask: number;
  compact: boolean;
  box: { widthPx: number; heightPx: number };
  tag: string;
}

export function bridgeFuzz(seedValue: number) {
  let seed = seedValue;
  const rnd = () => (seed = (seed * 48_271) % 2_147_483_647) / 2_147_483_647;
  const pick = <T>(from: readonly T[]): T => from[Math.floor(rnd() * from.length)]!;

  const bridgeFrom = (open: number, moves: Array<[string, number]>, openL = 'Opening', closeL = 'Closing'): WaterfallStep[] => {
    const steps: WaterfallStep[] = [{ label: openL, start: 0, end: open, value: open, isSubtotal: true, color: 'blue' }];
    let running = open;
    for (const [label, move] of moves) {
      steps.push({ label, start: running, end: running + move, value: move, isSubtotal: false, color: move >= 0 ? 'green' : 'red' });
      running += move;
    }
    steps.push({ label: closeL, start: 0, end: running, value: running, isSubtotal: true, color: 'teal' });
    return steps;
  };

  const profit = (mag: number): WaterfallStep[] => {
    const revenue = Math.round(mag * (0.3 + 0.7 * rnd()));
    const costOfSales = Math.round(revenue * (rnd() < 0.1 ? 0 : 0.05 + 0.85 * rnd()));
    const operatingExpenses = Math.round(revenue * (rnd() < 0.05 ? 0 : 0.02 + 0.7 * rnd()));
    const otherIncome = rnd() < 0.4 ? 0 : Math.round(revenue * 0.1 * rnd() * (rnd() < 0.5 ? 0.1 : 1));
    const otherExpenses = rnd() < 0.4 ? 0 : Math.round(revenue * 0.1 * rnd() * (rnd() < 0.5 ? 0.1 : 1));
    // A line the wrong side of zero, as the sheets say happens.
    const d = { revenue, costOfSales: costOfSales * (rnd() < 0.05 ? -1 : 1), operatingExpenses, otherIncome, otherExpenses, grossProfit: 0, netProfit: 0 };
    d.grossProfit = d.revenue - d.costOfSales;
    d.netProfit = d.grossProfit - d.operatingExpenses + d.otherIncome - d.otherExpenses;
    return buildProfitWaterfall(d).steps;
  };

  const cash = (mag: number): WaterfallStep[] => {
    const v = () => Math.round((rnd() - 0.5) * 2 * mag);
    const open = Math.round((rnd() - 0.2) * mag);
    const moves: Array<[string, number]> = [['Operating', v()]];
    if (rnd() < 0.85) moves.push(['Investing', Math.round(v() * (rnd() < 0.5 ? 0.05 : 0.6))]);
    if (rnd() < 0.85) moves.push(['Financing', Math.round(v() * (rnd() < 0.5 ? 0.05 : 0.6))]);
    if (rnd() < 0.3) moves.push(['Unexplained movement', Math.round(v() * 0.02)]);
    return bridgeFrom(open, moves, 'Opening cash', 'Closing cash');
  };

  /** Up to eight bars. */
  const random = (mag: number): WaterfallStep[] => {
    const family = pick(FAMILIES);
    const v = () => Math.round((rnd() - 0.5) * 2 * mag);
    const n = 1 + Math.floor(rnd() * 6);
    const moves = (of: () => number): Array<[string, number]> => Array.from({ length: n }, (_, i) => [rnd() < 0.6 ? pick(NAMES) : `Movement ${i + 1}`, of()]);
    switch (family) {
      case 'mixed': return bridgeFrom(v(), moves(() => Math.round(v() * (rnd() < 0.5 ? 0.01 : 1))));
      case 'allNeg': return bridgeFrom(-Math.abs(v()), moves(() => -Math.abs(v())));
      case 'allPos': return bridgeFrom(Math.abs(v()), moves(() => Math.abs(v())));
      case 'tiny': { const o = v() || 1000; return bridgeFrom(o, moves(() => Math.round(o * (rnd() - 0.5) * 0.01))); }
      case 'alternating': { const a = Math.abs(v()) || 1; let i = 0; return bridgeFrom(v(), moves(() => Math.round((i++ % 2 ? -a : a) * (0.5 + rnd())))); }
      case 'single': { const x = v(); return [{ label: 'Revenue', start: 0, end: x, value: x, isSubtotal: rnd() < 0.5, color: x >= 0 ? 'green' : 'red' }]; }
      case 'zero': return bridgeFrom(0, moves(() => 0));
      case 'midSubtotal': {
        const steps = bridgeFrom(Math.abs(v()), moves(() => Math.round(v() * 0.4)).slice(0, 5));
        const k = 1 + Math.floor(rnd() * (steps.length - 1));
        const at = steps[k - 1]!.end;
        steps.splice(k, 0, { label: 'Gross Profit', start: 0, end: at, value: at, isSubtotal: true, color: 'teal' });
        return steps;
      }
      default: return bridgeFrom(Math.round(v() * (rnd() < 0.15 ? 0 : 1)), moves(() => Math.round(v() * (rnd() < 0.4 ? 0.02 : 1))));
    }
  };

  /**
   * A print bridge with the arguments ITS CALLER passes: the profit bridge
   * asks `intervalsFor(box)` on a rung of the ladder; the cash bridge asks
   * for what its plot holds once the title is off, lowered until the rounded
   * axis fits (`cashBridgeIntervals`).
   */
  const print = (): PrintCase => {
    const mag = Math.pow(10, 4 + rnd() * 6);
    const shape = pick(['profit', 'profit', 'cash', 'cash', 'random'] as const);
    const steps = shape === 'profit' ? profit(mag) : shape === 'cash' ? cash(mag) : random(mag);
    const caller = shape === 'random' ? pick(['profit', 'cash'] as const) : shape;
    const money = (x: number) => inProse(formatStatementFigure(x, { scale: "R'000" }));
    const [first, last] = [steps[0]!.end, steps[steps.length - 1]!.end];
    const box = caller === 'profit' ? pick(BRIDGE_RUNGS)
      : rnd() < 0.5 ? HALF : { widthMm: CHART_MEASURE_MM, heightMm: 49 + Math.floor(rnd() * 24) };
    const title = caller === 'profit'
      ? `Revenue of ${money(first)} bridges to net profit of ${money(last)}.`
      : `Cash moved from ${money(first)} to ${money(last)} over the period.`;
    const plot = svgBoxFor(box, title);
    let ask = intervalsFor(box);
    if (caller === 'cash') {
      const room = intervalsFor(box, plot.heightMm);
      const values = steps.flatMap((s) => [s.start, s.end]);
      ask = room;
      while (ask > 1 && axisDomain(values, ask).splitNumber > room) ask -= 1;
    }
    return { steps, plot, ask, compact: isCompact(box), box: svgBoxPx(plot), tag: `${shape} via ${caller} ${box.heightMm}mm ask${ask}` };
  };

  /**
   * WIDE FIGURES BESIDE A NEIGHBOUR'S BAR — the class that sets a figure over
   * a bar that is not its own. A falling bridge in the trillions alternates
   * short steps (a percent or two, so the figure is wider than its band)
   * with longer ones a line or two tall: each short step's figure, set below
   * it, stands at the height of the next step's bar, and clears it only by
   * going a line or two further down.
   */
  const neighbours = (): WaterfallStep[] => {
    const total = Math.round(Math.pow(10, 12 + rnd() * 2));
    const steps: WaterfallStep[] = [{ label: 'Opening', start: 0, end: total, value: total, isSubtotal: true, color: 'teal' }];
    let running = total;
    const count = 4 + Math.floor(rnd() * 3);
    for (let i = 0; i < count; i += 1) {
      const move = -Math.round(total * (i % 2 === 0 ? 0.005 + rnd() * 0.02 : 0.03 + rnd() * 0.05));
      steps.push({ label: `Movement ${i + 1}`, start: running, end: running + move, value: move, isSubtotal: false, color: 'red' });
      running += move;
    }
    steps.push({ label: 'Closing', start: 0, end: running, value: running, isSubtotal: true, color: 'teal' });
    return steps;
  };

  return { rnd, pick, profit, cash, random, print, neighbours };
}
