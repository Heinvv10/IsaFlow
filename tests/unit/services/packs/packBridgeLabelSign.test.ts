/**
 * THE BRIDGE'S BAR LABELS AND THE TABLE ON THE SAME SHEET PRINT ONE SIGN.
 *
 * Sheet 6 printed Cost of sales as `1 431` in its income statement and
 * `(1 431)` on the bar a hundred millimetres below it. Brightsphere was
 * worse: Operating expenses `(3 717)` in the table against `3 717` on the
 * bar, and Other expenses `(411)` against `411` — three of six bars the
 * negation of the row above them. A footnote explained the convention at
 * length and TWO successive visual gates reported it anyway, which is the
 * evidence that a footnote is not a fix for one figure printing with two
 * signs on one sheet.
 *
 * The fix separates the two jobs the bar was doing with one number: the
 * LABEL carries the ledger's sign, the same figure the table states, and the
 * bar's DIRECTION carries the effect on profit. `WaterfallStep.labelValue` is
 * where that split lives.
 *
 * Asserted on the rendered SVG text, because that is the layer a reader sees
 * — a model field agreeing with a table proves nothing about what printed.
 */
import { describe, expect, it } from 'vitest';
import { buildProfitWaterfall } from '@/modules/accounting/services/reports/waterfallDataService';
import { waterfallOption } from '@/modules/accounting/services/packs/packChartOptions';
import { renderChartSvg } from '@/lib/charts/ssrSvg';
import { formatMoney } from '@/lib/format/money';
import { PACK_SCALE } from '@/modules/accounting/services/packs/pages/packBasis';

/** Two real ledgers, one of each shape the pack is rendered against. */
const LEDGERS = {
  // ISAFlow Demo: positive turnover, positive expense bands. The bar that
  // diverged is Cost of sales.
  demo: {
    revenue: 101_000, costOfSales: 1_431_000, operatingExpenses: 227_000,
    otherIncome: 18_000, otherExpenses: 12_000, netProfit: -1_544_000,
  },
  // Brightsphere: turnover in net DEBIT and both expense bands a net CREDIT,
  // so three of the six bars diverged rather than one.
  brightsphere: {
    revenue: -5_535_000, costOfSales: 0, operatingExpenses: -3_717_000,
    otherIncome: -1_000, otherExpenses: -411_000, netProfit: -1_408_000,
  },
} as const;

/** Every text node the rendered bridge draws. */
function labelsOf(f: (typeof LEDGERS)[keyof typeof LEDGERS]): string[] {
  const { steps } = buildProfitWaterfall({ ...f, grossProfit: f.revenue - f.costOfSales });
  const svg = renderChartSvg(waterfallOption(steps, PACK_SCALE), { widthMm: 170, heightMm: 110 });
  return [...String(svg).matchAll(/>([^<>]+)</g)].map((m) => m[1]!.trim());
}

describe('a profit bridge beside its own income statement', () => {
  for (const [name, f] of Object.entries(LEDGERS)) {
    it(`labels every expense bar with the ledger's sign, on ${name}`, () => {
      const drawn = labelsOf(f);
      // The three subtracted lines — the ones whose bar is the negation of
      // the table cell. Each must print exactly as the table prints it.
      for (const cell of [f.costOfSales, f.operatingExpenses, f.otherExpenses]) {
        if (cell === 0) continue;
        const asTable = formatMoney(cell, { scale: PACK_SCALE });
        const asEffect = formatMoney(-cell, { scale: PACK_SCALE });
        expect(drawn, `the bridge does not print ${asTable}, which the table does`)
          .toContain(asTable);
        // AND NOT the negation. Restore `formatMoney(step.value)` in
        // `makeWaterfallRenderItem` and this is the assertion that goes red.
        expect(drawn, `the bridge prints ${asEffect} for a table cell of ${asTable}`)
          .not.toContain(asEffect);
      }
      // The income lines and the subtotals were never in dispute and must not
      // move: their bar already carried the table's sign.
      expect(drawn).toContain(formatMoney(f.revenue, { scale: PACK_SCALE }));
      expect(drawn).toContain(formatMoney(f.netProfit, { scale: PACK_SCALE }));
    });
  }
});
