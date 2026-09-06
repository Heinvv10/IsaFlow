/**
 * The gate that refuses to render a pack whose figures do not reconcile.
 *
 * WHAT EACH FIXTURE MAKES REACHABLE is the thing to read for here. A pack
 * built from the healthy demo input is already correct, so it can only ever
 * prove the gate ACCEPTS — it cannot reach a single rejection branch. And a
 * gate that threw on everything would pass every `.toThrow()` test in this
 * file. So each rejection below is pinned by its own acceptance case: the same
 * shape, one figure moved, expected NOT to throw. A test that only asserts the
 * throw proves the branch is reachable, not that it discriminates.
 *
 * The hand-built documents are the real demo document with `pages` and
 * `provenance` replaced. Charts are cloned off the real profit bridge so their
 * `TrustedChartSvg` is one `renderChartSvg` actually produced — a fabricated
 * one would be testing a document shape the composer cannot build.
 */
import { describe, expect, it } from 'vitest';
import { assertPackIntegrity } from '@/modules/accounting/services/packs/figures/packFigureIntegrity';
import { PackFigureProvenance } from '@/modules/accounting/services/packs/figures/packFigureProvenance';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import type {
  PackChartSpec,
  PackPage,
  PackPageBlock,
  PackPagesDocument,
  PackTable,
  PackTableColumnKey,
  PackWaterfallBar,
} from '@/modules/accounting/services/packs/pages/packPageModel';
import { brightsphereInput, demoInput, demoSet, figures } from './fixtures/boardPackInputs';

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

/** The three totals every pack must record, at values that foot. Overriding
 *  one is how the balance-sheet branch is reached. */
function balanced(
  p: PackFigureProvenance,
  totals: { assets?: number; liabilities?: number; equity?: number } = {},
): void {
  p.figure('packFigureSet.current.totalAssets', totals.assets ?? 3_900_000, 'money');
  p.figure('packFigureSet.current.totalLiabilities', totals.liabilities ?? 1_640_000, 'money');
  p.figure('packFigureSet.current.totalEquity', totals.equity ?? 2_260_000, 'money');
}

function page(blocks: PackPageBlock[]): PackPage {
  return { number: 7, title: 'Cash rose to 610', section: 'Financials', orientation: 'portrait', density: 'high', blocks, footnotes: [] };
}

function docOf(p: PackFigureProvenance, blocks: PackPageBlock[] = []): PackPagesDocument {
  return { ...template, provenance: p, pages: [page(blocks)] };
}

function tableOf(columns: PackTableColumnKey[], figures: PackTable['rows'][number]['figures']): PackPageBlock {
  return {
    kind: 'table',
    table: { scale: "R'000", columns, rows: [{ label: 'Revenue', level: 0, role: 'line', figures }] },
  };
}

describe('assertPackIntegrity', () => {
  it('passes a well-formed pack', () => {
    expect(() => assertPackIntegrity(buildBoardPackPages(demoInput))).not.toThrow();
  });

  it('passes the pack with no prior period, negative equity and no budget', () => {
    // Brightsphere reaches every absent-comparative and not-meaningful branch
    // the demo pack cannot. If the gate mistook an honest absence for a
    // failure, this is where it would show.
    expect(() => assertPackIntegrity(buildBoardPackPages(brightsphereInput))).not.toThrow();
  });

  it('fails when the balance sheet does not foot', () => {
    const p = new PackFigureProvenance();
    balanced(p, { equity: 2_000_000 });
    expect(() => assertPackIntegrity(docOf(p)))
      .toThrow(/assets.*liabilities.*equity|does not foot/i);
  });

  it('accepts the same balance sheet when it foots', () => {
    const p = new PackFigureProvenance();
    balanced(p);
    expect(() => assertPackIntegrity(docOf(p))).not.toThrow();
  });

  it('refuses a pack that never recorded the balance-sheet totals at all', () => {
    // The quietest false green: a gate that skips a missing figure passes a
    // pack it never checked.
    expect(() => assertPackIntegrity(docOf(new PackFigureProvenance())))
      .toThrow(/never recorded/i);
  });

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

  it('fails when the same figure appears twice with different rounding', () => {
    const p = new PackFigureProvenance();
    balanced(p);
    p.figure('packFigureSet.current.revenue', 1_000_000, 'money');
    p.figure('packFigureSet.current.revenue', 1_000_000.4, 'money');
    expect(() => assertPackIntegrity(docOf(p))).toThrow(/disagree/i);
  });

  it('accepts the same figure issued twice at the same value', () => {
    const p = new PackFigureProvenance();
    balanced(p);
    p.figure('packFigureSet.current.revenue', 1_000_000, 'money');
    p.figure('packFigureSet.current.revenue', 1_000_000, 'money');
    expect(() => assertPackIntegrity(docOf(p))).not.toThrow();
  });

  it('fails when a percentage does not recompute from its stated numerator and denominator', () => {
    const p = new PackFigureProvenance();
    balanced(p);
    const figure = p.figure('marginPct.grossMargin', 45, 'pct', undefined, { numerator: 400, denominator: 1000 });
    const block: PackPageBlock = { kind: 'kpiTiles', tiles: [{ label: 'Gross margin', figure, delta: null, trendFootnote: null, sparklineSvg: null }] };
    expect(() => assertPackIntegrity(docOf(p, [block]))).toThrow(/recompute|does not/i);
  });

  it('accepts a percentage that recomputes', () => {
    const p = new PackFigureProvenance();
    balanced(p);
    const figure = p.figure('marginPct.grossMargin', 40, 'pct', undefined, { numerator: 400, denominator: 1000 });
    const block: PackPageBlock = { kind: 'kpiTiles', tiles: [{ label: 'Gross margin', figure, delta: null, trendFootnote: null, sparklineSvg: null }] };
    expect(() => assertPackIntegrity(docOf(p, [block]))).not.toThrow();
  });

  it('skips a not-meaningful figure rather than failing it (R-P44)', () => {
    // Both halves of the null path at once: a null gross profit leaves the
    // gross-profit identity nothing to reconcile, and a null margin carrying
    // a basis has no printed percentage to recompute. Neither is a defect —
    // each states its own reason.
    const p = new PackFigureProvenance();
    balanced(p);
    p.figure('packFigureSet.current.revenue', 0, 'money');
    p.figure('packFigureSet.current.costOfSales', 120_000, 'money');
    p.figure('packStatementTables.grossProfit', null, 'money', 'Nothing was captured for this line.');
    const figure = p.figure('marginPct.grossMargin', null, 'pct', 'Revenue is not positive, so there is no turnover to take a margin of.', { numerator: 0, denominator: 0 });
    const block: PackPageBlock = { kind: 'kpiTiles', tiles: [{ label: 'Gross margin', figure, delta: null, trendFootnote: null, sparklineSvg: null }] };
    expect(() => assertPackIntegrity(docOf(p, [block]))).not.toThrow();
  });

  it('fails a figure printed on a page that no service issued', () => {
    const recorded = new PackFigureProvenance();
    balanced(recorded);
    const other = new PackFigureProvenance();
    const stray = other.figure('packFigureSet.current.revenue', 4_200_000, 'money');
    expect(() => assertPackIntegrity(docOf(recorded, [tableOf(['actual'], { actual: stray })])))
      .toThrow(/no service issued|provenance map/i);
  });

  it('fails a comparative column filled from a current-period reading', () => {
    const p = new PackFigureProvenance();
    balanced(p);
    const actual = p.figure('packFigureSet.current.revenue', 4_200_000, 'money');
    const prior = p.figure('packFigureSet.current.revenue.prior', 3_750_000, 'money');
    const wrong = tableOf(['actual', 'prior'], { actual, prior: actual });
    const right = tableOf(['actual', 'prior'], { actual, prior });
    expect(() => assertPackIntegrity(docOf(p, [wrong]))).toThrow(/comparative/i);
    expect(() => assertPackIntegrity(docOf(p, [right]))).not.toThrow();
  });

  it('fails a table declaring a column no row carries', () => {
    const p = new PackFigureProvenance();
    balanced(p);
    const actual = p.figure('packFigureSet.current.revenue', 4_200_000, 'money');
    expect(() => assertPackIntegrity(docOf(p, [tableOf(['actual', 'budget'], { actual })])))
      .toThrow(/no row carries/i);
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

  it('fails the render rather than warning', () => {
    // The whole point. A warning on a document a director forwards to a bank
    // is a warning nobody reads.
    const p = new PackFigureProvenance();
    balanced(p, { equity: 1 });
    expect(assertPackIntegrity).toBeTypeOf('function');
    expect(assertPackIntegrity(buildBoardPackPages(demoInput))).toBeUndefined();
    expect(() => assertPackIntegrity(docOf(p))).toThrow();
  });
});

describe('buildBoardPackPages calls the gate', () => {
  it('refuses to build a pack whose balance sheet does not foot', () => {
    // A gate nothing invokes is the failure mode that matters most: every
    // test above would still pass with the call site deleted.
    const broken = { ...demoInput, set: { ...demoSet, current: figures({ totalEquity: 2_000_000 }) } };
    expect(() => buildBoardPackPages(broken)).toThrow(/integrity/i);
  });

  it('bridges revenue to net profit through a named uncaptured step', () => {
    // Before the gate, page 6's Net Profit bar floated R223,000 clear of the
    // chain under a title claiming revenue "bridges to" net profit. The gate
    // refuses that, so the gap is drawn as its own bar.
    const bars = template.pages.find((pg) => pg.number === 6)!.blocks
      .flatMap((b) => (b.kind === 'chart' ? [b.chart] : []))[0]!.waterfallBars!;
    expect(bars.map((b) => b.label)).toContain('Other, not separately captured');
    expect(bars[bars.length - 2]!.end).toBe(demoSet.current.netProfit);
    expect(bars[bars.length - 1]!.end).toBe(demoSet.current.netProfit);
    expect(bars.some((b) => b.kind === 'subtotal')).toBe(true);
  });
});
