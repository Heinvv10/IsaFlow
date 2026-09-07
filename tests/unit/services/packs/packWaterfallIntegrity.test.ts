/**
 * The bridge half of the figure-integrity gate — the subtotal-aware bar walk,
 * the cash-bridge endpoints, and the plug-proportion rule.
 *
 * Split from `packFigureIntegrity.test.ts` for the file-size cap, along the
 * same seam the implementation uses: `packWaterfallIntegrity.ts` owns
 * everything a bridge asserts, and this file drives it. The helpers are the
 * same ones the sibling uses and for the same reason — charts are cloned off
 * the real page-6 bridge so their `TrustedChartSvg` is one `renderChartSvg`
 * actually produced, and every rejection is pinned by an acceptance case of
 * the same shape.
 */
import { describe, expect, it } from 'vitest';
import { assertPackIntegrity } from '@/modules/accounting/services/packs/figures/packFigureIntegrity';
import {
  disproportionatePlugSentence,
  uncapturedShare,
} from '@/modules/accounting/services/packs/figures/packWaterfallIntegrity';
import { PackFigureProvenance } from '@/modules/accounting/services/packs/figures/packFigureProvenance';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import type {
  PackChartSpec,
  PackComparativePeriod,
  PackPage,
  PackPageBlock,
  PackPagesDocument,
  PackWaterfallBar,
} from '@/modules/accounting/services/packs/pages/packPageModel';
import { demoInput } from './fixtures/boardPackInputs';

const template = buildBoardPackPages(demoInput);

/** The real page-6 bridge, so cloned charts carry a genuine trusted SVG. */
const realBridge: PackChartSpec = template.pages
  .find((page) => page.number === 6)!
  .blocks.flatMap((block) => (block.kind === 'chart' ? [block.chart] : []))[0]!;

const chartOf = (id: string, bars: PackWaterfallBar[]): PackChartSpec => ({
  ...realBridge,
  id,
  waterfallBars: bars,
});

/** The three totals every pack must record, at values that foot — every case
 *  below is about a bridge, so the balance sheet must not be what fails. */
function balanced(p: PackFigureProvenance): void {
  p.figure('packFigureSet.current.totalAssets', 3_900_000, 'money');
  p.figure('packFigureSet.current.totalLiabilities', 1_640_000, 'money');
  p.figure('packFigureSet.current.totalEquity', 2_260_000, 'money');
}

function page(blocks: PackPageBlock[]): PackPage {
  return { number: 7, title: 'Cash rose to 610', section: 'Financials', orientation: 'portrait', density: 'high', blocks, footnotes: [] };
}

function docOf(
  p: PackFigureProvenance,
  blocks: PackPageBlock[] = [],
  comparativePeriod: PackComparativePeriod | null = null,
): PackPagesDocument {
  return { ...template, provenance: p, pages: [page(blocks)], comparativePeriod };
}

describe('assertPackIntegrity — bridges', () => {
  it("fails when a waterfall's bars do not sum to its endpoints", () => {
    const p = new PackFigureProvenance();
    balanced(p);
    const bars: PackWaterfallBar[] = [
      { label: 'Revenue', start: 0, end: 1000, kind: 'open' },
      { label: 'Costs', start: 1000, end: 700, kind: 'decrease' },
      { label: 'Net', start: 0, end: 900, kind: 'close' }, // should be 700
    ];
    expect(() => assertPackIntegrity(docOf(p, [{ kind: 'chart', chart: chartOf('profit-bridge', bars) }])))
      .toThrow(/waterfall|bridge/i);
  });

  it('accepts a bridge whose bars DO reach the endpoint', () => {
    const p = new PackFigureProvenance();
    balanced(p);
    const bars: PackWaterfallBar[] = [
      { label: 'Revenue', start: 0, end: 1000, kind: 'open' },
      { label: 'Costs', start: 1000, end: 700, kind: 'decrease' },
      { label: 'Net', start: 0, end: 700, kind: 'close' },
    ];
    expect(() => assertPackIntegrity(docOf(p, [{ kind: 'chart', chart: chartOf('profit-bridge', bars) }])))
      .not.toThrow();
  });

  it('accepts a mid-statement subtotal bar drawn from the axis (R-P50)', () => {
    // The false-positive case. A subtotal restarts the bridge at zero, so a
    // gate walking `start` against the previous `end` reports a break in a
    // chart that is correct — and a gate that fails honest packs is one
    // everybody learns to bypass.
    const p = new PackFigureProvenance();
    balanced(p);
    const bars: PackWaterfallBar[] = [
      { label: 'Revenue', start: 0, end: 1000, kind: 'open' },
      { label: 'Cost of sales', start: 1000, end: 600, kind: 'decrease' },
      { label: 'Gross profit', start: 0, end: 600, kind: 'subtotal' },
      { label: 'Operating expenses', start: 600, end: 400, kind: 'decrease' },
      { label: 'Net profit', start: 0, end: 400, kind: 'close' },
    ];
    expect(() => assertPackIntegrity(docOf(p, [{ kind: 'chart', chart: chartOf('profit-bridge', bars) }])))
      .not.toThrow();
  });

  it('fails a subtotal the chain never reaches', () => {
    // And the same shape with the subtotal moved: the 'subtotal' kind must
    // still ASSERT something, or admitting it would just be a hole.
    const p = new PackFigureProvenance();
    balanced(p);
    const bars: PackWaterfallBar[] = [
      { label: 'Revenue', start: 0, end: 1000, kind: 'open' },
      { label: 'Cost of sales', start: 1000, end: 600, kind: 'decrease' },
      { label: 'Gross profit', start: 0, end: 650, kind: 'subtotal' }, // should be 600
      { label: 'Operating expenses', start: 650, end: 450, kind: 'decrease' },
      { label: 'Net profit', start: 0, end: 450, kind: 'close' },
    ];
    expect(() => assertPackIntegrity(docOf(p, [{ kind: 'chart', chart: chartOf('profit-bridge', bars) }])))
      .toThrow(/Gross profit/);
  });

  it('refuses a waterfall carrying no bars to check', () => {
    const p = new PackFigureProvenance();
    balanced(p);
    const chart: PackChartSpec = { ...realBridge, id: 'profit-bridge', waterfallBars: undefined };
    expect(() => assertPackIntegrity(docOf(p, [{ kind: 'chart', chart }])))
      .toThrow(/carries no bars/i);
  });

  it('fails a cash bridge that does not reconcile to the closing balance', () => {
    const p = new PackFigureProvenance();
    balanced(p);
    p.figure('packFigureSet.prior.cash', 486_000, 'money');
    p.figure('packFigureSet.current.cash', 610_000, 'money');
    // Bars that foot among themselves, on the WRONG closing balance — which
    // `checkWaterfall` alone cannot see.
    const bars: PackWaterfallBar[] = [
      { label: 'Opening cash', start: 0, end: 486_000, kind: 'open' },
      { label: 'Operating', start: 486_000, end: 700_000, kind: 'increase' },
      { label: 'Closing cash', start: 0, end: 700_000, kind: 'close' },
    ];
    expect(() => assertPackIntegrity(docOf(p, [{ kind: 'chart', chart: chartOf('cash-bridge', bars) }])))
      .toThrow(/reconcile/i);
  });

  it('accepts a cash bridge that foots on a NAMED plug', () => {
    // Page 8's real case: the figure set carries no reconciling items, so the
    // residual is drawn as its own labelled step. A plug a director can see
    // is not the defect this gate exists to catch.
    const p = new PackFigureProvenance();
    balanced(p);
    p.figure('packFigureSet.prior.cash', 486_000, 'money');
    p.figure('packFigureSet.current.cash', 610_000, 'money');
    const bars: PackWaterfallBar[] = [
      { label: 'Opening cash', start: 0, end: 486_000, kind: 'open' },
      { label: 'Operating', start: 486_000, end: 700_000, kind: 'increase' },
      { label: 'Unexplained movement', start: 700_000, end: 610_000, kind: 'decrease' },
      { label: 'Closing cash', start: 0, end: 610_000, kind: 'close' },
    ];
    expect(() => assertPackIntegrity(docOf(p, [{ kind: 'chart', chart: chartOf('cash-bridge', bars) }])))
      .not.toThrow();
  });

  it('fails a bridge that leans on its plug while the page stays quiet (I-3)', () => {
    // The bridge FOOTS — every other check in the gate passes it — and its
    // unmeasured step is larger than the movement it sits inside. Nothing
    // else here would ever fire on this chart.
    const p = new PackFigureProvenance();
    balanced(p);
    const bars: PackWaterfallBar[] = [
      { label: 'Opening cash', start: 0, end: 486_000, kind: 'open' },
      { label: 'Operating', start: 486_000, end: 876_000, kind: 'increase' },
      { label: 'Unexplained movement', start: 876_000, end: 610_000, kind: 'decrease', uncaptured: true },
      { label: 'Closing cash', start: 0, end: 610_000, kind: 'close' },
    ];
    const chart = chartOf('cash-bridge', bars);
    expect(uncapturedShare(bars)).toBeGreaterThan(2);
    expect(() => assertPackIntegrity(docOf(p, [{ kind: 'chart', chart }])))
      .toThrow(/leans on an unmeasured step and the page does not say so/);
  });

  it('accepts the same bridge when the page states the size of the plug', () => {
    const p = new PackFigureProvenance();
    balanced(p);
    const bars: PackWaterfallBar[] = [
      { label: 'Opening cash', start: 0, end: 486_000, kind: 'open' },
      { label: 'Operating', start: 486_000, end: 876_000, kind: 'increase' },
      { label: 'Unexplained movement', start: 876_000, end: 610_000, kind: 'decrease', uncaptured: true },
      { label: 'Closing cash', start: 0, end: 610_000, kind: 'close' },
    ];
    const chart = chartOf('cash-bridge', bars);
    const said = disproportionatePlugSentence(chart)!;
    expect(said).toMatch(/R 266 000/);
    const blocks: PackPageBlock[] = [
      { kind: 'chart', chart },
      { kind: 'disclosure', disclosure: { heading: 'How much of this bridge is unexplained', notes: [{ heading: 'Size', body: said }] } },
    ];
    expect(() => assertPackIntegrity(docOf(p, blocks))).not.toThrow();
  });

  it('says nothing about a plug that is a genuine remainder', () => {
    // The negative pin the threshold needs. A plug at 2% of the endpoint is
    // a residual; requiring a disclosure for it would put one on every pack,
    // and a disclosure that always appears is one readers skip.
    const p = new PackFigureProvenance();
    balanced(p);
    const bars: PackWaterfallBar[] = [
      { label: 'Opening cash', start: 0, end: 486_000, kind: 'open' },
      { label: 'Operating', start: 486_000, end: 622_000, kind: 'increase' },
      { label: 'Unexplained movement', start: 622_000, end: 610_000, kind: 'decrease', uncaptured: true },
      { label: 'Closing cash', start: 0, end: 610_000, kind: 'close' },
    ];
    const chart = chartOf('cash-bridge', bars);
    expect(uncapturedShare(bars)).toBeCloseTo(12_000 / 124_000, 6);
    expect(disproportionatePlugSentence(chart)).toBeNull();
    expect(() => assertPackIntegrity(docOf(p, [{ kind: 'chart', chart }]))).not.toThrow();
  });

  it('judges the plug against the smaller of the endpoint and the movement', () => {
    // The denominator argument, pinned. Page 8's plug is 44% of closing cash
    // and 214% of the movement it sits inside; taking the endpoint alone
    // would still fire here, but the same bridge with a larger closing
    // balance would not — and the plug would be no less dominant.
    const bars: PackWaterfallBar[] = [
      { label: 'Opening cash', start: 0, end: 9_876_000, kind: 'open' },
      { label: 'Operating', start: 9_876_000, end: 10_266_000, kind: 'increase' },
      { label: 'Unexplained movement', start: 10_266_000, end: 10_000_000, kind: 'decrease', uncaptured: true },
      { label: 'Closing cash', start: 0, end: 10_000_000, kind: 'close' },
    ];
    // 266,000 is 2.7% of the R10m endpoint — invisible — but 214% of the
    // R124,000 the bridge actually explains.
    expect(uncapturedShare(bars)).toBeCloseTo(266_000 / 124_000, 6);
    expect(disproportionatePlugSentence(chartOf('cash-bridge', bars))).not.toBeNull();
  });

});
