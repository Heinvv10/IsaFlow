/**
 * The twelve-page board pack, composed.
 *
 * Two fixtures, and the second is the one that matters. `demoInput` is a
 * healthy company with a prior period and a budget — it can only ever
 * exercise the happy path, so on its own it would leave every null-prior and
 * null-budget branch in this pack unreached. `brightsphereInput` mirrors the
 * real client: negative revenue, negative equity, no prior period, no budget.
 *
 * The block-content assertions exist because "at least three blocks" passes
 * trivially on three EMPTY blocks. A page carrying an empty table, an empty
 * tile strip and an unapproved narrative satisfies the count and ships a
 * blank page, which is the defect spec §5.7 names.
 */
import { describe, expect, it } from 'vitest';
import { buildBoardPackPages, type BoardPackInput } from '@/modules/accounting/services/packs/pages/boardPackPages';
import {
  assertPageTitleIsAMessage,
  type PackPageBlock,
} from '@/modules/accounting/services/packs/pages/packPageModel';
import type { PackFigureSet } from '@/modules/accounting/services/packs/figures/packFigureSet';
import type { ReportPackFigures } from '@/modules/accounting/services/reports/reportPackDataService';
import type { PackTrendPoint } from '@/modules/accounting/services/packs/packTrendService';
import type { PackMatter } from '@/modules/accounting/services/packs/pages/packMatters';
import type { PackBrand } from '@/modules/accounting/services/packs/packBrand';
import { formatMoney, formatPctMagnitude, toMoneyScale } from '@/lib/format/money';
import { marginPct } from '@/modules/accounting/services/reports/marginPct';
import { CHART_HEIGHT_MM } from '@/lib/charts/ssrSvg';
import { formatFigureText } from '@/components/accounting/packs/primitives/packFigureText';
import { TRENDS_PANELS_SPECIFIED } from '@/modules/accounting/services/packs/pages/packPageCharts';

function figures(overrides: Partial<ReportPackFigures>): ReportPackFigures {
  return {
    companyName: 'ISAFlow Demo (Pty) Ltd',
    period: '2026-03-01 to 2026-08-31',
    revenue: 4_200_000,
    costOfSales: 2_310_000,
    operatingExpenses: 1_180_000,
    otherIncome: 40_000,
    otherExpenses: 15_000,
    operatingProfit: 735_000,
    netProfit: 512_000,
    totalAssets: 3_900_000,
    totalLiabilities: 1_640_000,
    totalEquity: 2_260_000,
    currentAssets: 1_850_000,
    currentLiabilities: 940_000,
    cash: 610_000,
    accountsReceivable: 720_000,
    accountsPayable: 430_000,
    inventory: 310_000,
    operatingCashFlow: 690_000,
    capitalExpenditure: 180_000,
    financingCashFlow: -120_000,
    inventoryCaveat: null,
    classificationCaveat: null,
    ...overrides,
  };
}

const trend: PackTrendPoint[] = Array.from({ length: 13 }, (_, i) => {
  const revenue = 600_000 + i * 12_000;
  const costOfSales = 330_000 + i * 6_000;
  return {
    month: `2025-${String(i + 1).padStart(2, '0')}`,
    label: `M${i + 1}`,
    revenue,
    expenses: 520_000 + i * 9_000,
    netProfit: 80_000 + i * 3_000,
    costOfSales,
    operatingExpenses: 190_000 + i * 3_000,
    grossMarginPct: Math.round(((revenue - costOfSales) / revenue) * 10000) / 100,
    cash: 590_000 + i * 5_000,
    accountsReceivable: 700_000 + i * 4_000,
    debtorDays: Math.round(((700_000 + i * 4_000) / revenue) * 30 * 100) / 100,
  };
});

/**
 * Every month has zero revenue, so `grossMarginPct` and `debtorDays` are both
 * not-meaningful (R-P44/R-P45) throughout — the only fixture in this file
 * that genuinely produces FEWER than the six specified panels. Money panels
 * (revenue, operating expenses, net profit, cash) still draw fine: none of
 * them needs a positive revenue.
 */
const zeroRevenueTrend: PackTrendPoint[] = trend.map((point) => ({
  ...point,
  revenue: 0,
  grossMarginPct: null,
  debtorDays: null,
}));

const brand: PackBrand = {
  primaryColour: '#1f4e79',
  secondaryColour: '#c8a86b',
  logoUrl: null,
  footerText: null,
  primaryInk: '#ffffff',
};

const matters: PackMatter[] = [
  {
    issue: 'Aged debtor concentration: Acme Holdings is 34.0% of total debtors owed',
    quantum: 244_800,
    owner: 'Credit control',
    movement: 'Not tracked — no prior board pack is stored to compare against.',
    decisionRequired: 'Approve escalation, a credit hold, or a write-off review for this account.',
  },
];

const demoSet: PackFigureSet = {
  current: figures({}),
  currentWindow: { start: '2026-03-01', end: '2026-08-31' },
  prior: figures({
    revenue: 3_750_000,
    costOfSales: 2_100_000,
    operatingExpenses: 1_090_000,
    operatingProfit: 560_000,
    netProfit: 388_000,
    totalAssets: 3_540_000,
    totalLiabilities: 1_580_000,
    totalEquity: 1_960_000,
    currentAssets: 1_690_000,
    currentLiabilities: 900_000,
    cash: 486_000,
    accountsReceivable: 660_000,
    accountsPayable: 410_000,
    inventory: 295_000,
    operatingCashFlow: 540_000,
    capitalExpenditure: 150_000,
    financingCashFlow: -90_000,
  }),
  priorWindow: { start: '2025-09-01', end: '2026-02-28' },
  budget: {
    fiscalYear: 2026,
    totals: { budget: 4_000_000, actual: 4_200_000, variance: 200_000 },
    rows: [
      {
        accountCode: '1000',
        accountName: 'Sales',
        accountType: 'revenue',
        budget: 4_000_000,
        actual: 4_200_000,
        variance: 200_000,
        variancePct: 5,
      },
    ],
    postedThrough: '2026-08-31',
  },
};

const demoInput: BoardPackInput = {
  companyLegalName: 'ISAFlow Demo (Pty) Ltd',
  period: '1 March 2026 to 31 August 2026',
  generatedAt: '2026-09-07T06:00:00.000Z',
  draft: false,
  preparedBy: 'Finance',
  brand,
  set: demoSet,
  trend,
  matters,
  commentary: {
    status: 'approved',
    body: 'Trading held up through the winter and the operating line improved.',
    actions: ['Approve the revised debtor policy.'],
  },
  mattersCommentary: {
    status: 'approved',
    body: 'One concentration matter carries forward from the last meeting.',
    actions: [],
  },
  ledgerVersion: 'posted-through 2026-08-31',
};

/** Same as `demoInput` in every other respect, but its trend genuinely draws
 *  fewer than the six specified panels — see `zeroRevenueTrend`. */
const noRatioPanelsInput: BoardPackInput = { ...demoInput, trend: zeroRevenueTrend };

/**
 * Brightsphere: negative revenue, negative equity, no prior, no budget, and
 * no approved commentary on either narrative page.
 */
const brightsphereSet: PackFigureSet = {
  current: figures({
    companyName: 'Brightsphere (Pty) Ltd',
    revenue: -5_535_000,
    costOfSales: 0,
    operatingExpenses: -3_717_000,
    otherIncome: 0,
    otherExpenses: 0,
    operatingProfit: -1_818_000,
    netProfit: -1_818_000,
    totalAssets: 200_000,
    totalLiabilities: 450_000,
    totalEquity: -250_000,
    currentAssets: 100_000,
    currentLiabilities: 380_000,
    cash: 12_000,
    accountsReceivable: 64_000,
    accountsPayable: 210_000,
    inventory: 0,
    operatingCashFlow: -95_000,
    capitalExpenditure: 0,
    financingCashFlow: 0,
    inventoryCaveat: 'No inventory accounts are classified, so a quick ratio has not excluded any.',
    classificationCaveat: null,
  }),
  currentWindow: { start: '2026-03-01', end: '2026-08-31' },
  prior: null,
  priorWindow: { start: '2025-09-01', end: '2026-02-28' },
  budget: null,
};

const brightsphereInput: BoardPackInput = {
  ...demoInput,
  companyLegalName: 'Brightsphere (Pty) Ltd',
  set: brightsphereSet,
  trend: [],
  matters: [
    {
      issue: 'No matters require board attention this period — every check ran clean.',
      quantum: null,
      owner: 'Finance',
      movement: 'Not tracked — no prior board pack is stored to compare against.',
      decisionRequired: 'None. Note for the record.',
    },
  ],
  commentary: null,
  mattersCommentary: null,
  ledgerVersion: null,
};

/** Whether a block puts anything on the page. Counting blocks is not enough. */
function blockHasContent(block: PackPageBlock): boolean {
  switch (block.kind) {
    case 'kpiTiles':
      return block.tiles.length > 0;
    case 'statTiles':
      return block.groups.length > 0 && block.groups.every((g) => g.stats.length > 0);
    case 'table':
      return block.table.rows.length > 0 && block.table.columns.length > 0;
    case 'scorecard':
      return block.groups.length > 0 && block.groups.every((g) => g.rows.length > 0);
    case 'chart':
      return block.chart.svg.length > 0;
    case 'smallMultiples':
      return block.panels.length > 0 && block.panels.every((p) => p.svg.length > 0);
    case 'narrative':
      // A 'pending' narrative renders a visible placeholder (NarrativeColumns);
      // a 'draft' one renders literally nothing and is never page content.
      return block.narrative.status === 'pending'
        ? true
        : block.narrative.status === 'approved' && (block.narrative.body ?? '').trim() !== '';
    case 'disclosure':
      return block.disclosure.notes.length > 0
        && block.disclosure.notes.every((n) => n.body.trim() !== '');
    case 'definitions':
      return block.entries.length > 0;
  }
}

describe('buildBoardPackPages', () => {
  const doc = buildBoardPackPages(demoInput);

  it('is exactly twelve pages, numbered 1..12', () => {
    expect(doc.pages.map((p) => p.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it('titles every content page with a message', () => {
    for (const page of doc.pages) {
      expect(() => assertPageTitleIsAMessage(page.title, page.number), `page ${page.number}`).not.toThrow();
    }
  });

  it('gives every page its own title — no two pages say the same thing', () => {
    const titles = doc.pages.map((p) => p.title);
    expect(new Set(titles).size).toBe(12);
  });

  it('puts a chart on the results, position, cash and trends pages', () => {
    for (const n of [6, 7, 8, 10]) {
      const page = doc.pages.find((p) => p.number === n)!;
      expect(page.blocks.some((b) => b.kind === 'chart' || b.kind === 'smallMultiples'), `page ${n}`).toBe(true);
    }
  });

  it('gives every content page at least three blocks', () => {
    for (const page of doc.pages.filter((p) => p.number >= 3 && p.number !== 4)) {
      expect(page.blocks.length, `page ${page.number}`).toBeGreaterThanOrEqual(3);
    }
  });

  it('puts content in every block it emits, on both fixtures', () => {
    for (const source of [doc, buildBoardPackPages(brightsphereInput)]) {
      for (const page of source.pages) {
        for (const block of page.blocks) {
          expect(blockHasContent(block), `page ${page.number} block ${block.kind}`).toBe(true);
        }
      }
    }
  });

  it('keeps the narrative page free of tabular figures, per spec §4.A page 4', () => {
    const page = doc.pages.find((p) => p.number === 4)!;
    expect(page.blocks.every((b) => b.kind === 'narrative')).toBe(true);
    expect(page.blocks.length).toBeGreaterThan(0);
  });

  it('renders the trends page landscape and every other page portrait', () => {
    expect(doc.pages.find((p) => p.number === 10)?.orientation).toBe('landscape');
    expect(doc.pages.filter((p) => p.orientation === 'landscape')).toHaveLength(1);
  });

  it('shows a comparative on every KPI and every statement row that has one', () => {
    const tiles = doc.pages.find((p) => p.number === 3)!.blocks
      .flatMap((b) => (b.kind === 'kpiTiles' ? b.tiles : []));
    expect(tiles.length).toBe(8);
    expect(tiles.every((t) => t.delta !== null)).toBe(true);
  });

  it('states the comparison basis on every delta it prints', () => {
    const tiles = doc.pages.find((p) => p.number === 3)!.blocks
      .flatMap((b) => (b.kind === 'kpiTiles' ? b.tiles : []));
    expect(tiles.every((t) => (t.delta?.basis ?? '').trim() !== '')).toBe(true);
  });

  it('carries the prior column on the statement tables when there is a prior period', () => {
    for (const n of [5, 6, 7, 8]) {
      const tables = doc.pages.find((p) => p.number === n)!.blocks
        .flatMap((b) => (b.kind === 'table' ? [b.table] : []));
      expect(tables.length, `page ${n}`).toBeGreaterThan(0);
      expect(tables.every((t) => t.columns.includes('prior')), `page ${n}`).toBe(true);
    }
  });

  it('renders the supplied ledger version on the basis page, not an invented one', () => {
    expect(doc.basisOfPreparation.ledgerVersion).toBe('posted-through 2026-08-31');
  });

  it('survives a company with no prior period, no budget and negative revenue', () => {
    const doc2 = buildBoardPackPages(brightsphereInput);
    expect(doc2.pages).toHaveLength(12);
    for (const page of doc2.pages) {
      expect(() => assertPageTitleIsAMessage(page.title, page.number), `page ${page.number}`).not.toThrow();
    }
    for (const page of doc2.pages.filter((p) => p.number >= 3 && p.number !== 4)) {
      expect(page.blocks.length, `page ${page.number}`).toBeGreaterThanOrEqual(3);
    }
  });

  it('fabricates no comparative for a company with no prior period', () => {
    const doc2 = buildBoardPackPages(brightsphereInput);
    for (const page of doc2.pages) {
      for (const block of page.blocks) {
        if (block.kind === 'table') {
          for (const column of ['prior', 'change', 'changePct'] as const) {
            expect(block.table.columns.includes(column), `page ${page.number} ${column}`).toBe(false);
          }
        }
        if (block.kind === 'kpiTiles') {
          expect(block.tiles.every((t) => t.delta === null), `page ${page.number}`).toBe(true);
        }
        if (block.kind === 'scorecard') {
          expect(block.groups.flatMap((g) => g.rows).every((r) => r.prior === null)).toBe(true);
        }
      }
    }
  });

  it('states the ledger version is unavailable rather than inventing one', () => {
    const doc2 = buildBoardPackPages(brightsphereInput);
    expect(doc2.basisOfPreparation.ledgerVersion).toMatch(/unavailable/i);
  });

  it('renders a visible pending placeholder where commentary is not approved', () => {
    const doc2 = buildBoardPackPages(brightsphereInput);
    for (const n of [4, 11]) {
      const narratives = doc2.pages.find((p) => p.number === n)!.blocks
        .flatMap((b) => (b.kind === 'narrative' ? [b.narrative] : []));
      expect(narratives.length, `page ${n}`).toBeGreaterThan(0);
      expect(narratives.some((x) => x.status === 'pending'), `page ${n}`).toBe(true);
      expect(narratives.every((x) => x.status !== 'draft'), `page ${n}`).toBe(true);
    }
  });

  // The 1000x defect: `PackTable.scale` said "R'000" while `formatMoney` had
  // no scale handling at all, so R4 200 000 printed as `4 200 000` under a
  // thousands header. Eighteen tests passed because not one read a formatted
  // cell against the header above it. This is that assertion.
  it('formats a statement cell at the scale its own header states', () => {
    const scale = toMoneyScale(doc.numberConvention.scale);
    expect(scale, doc.numberConvention.scale).not.toBeNull();

    const table = doc.pages.find((p) => p.number === 5)!.blocks
      .flatMap((b) => (b.kind === 'table' ? [b.table] : []))[0]!;
    expect(table.scale).toBe(doc.numberConvention.scale);

    const revenue = table.rows.find((r) => r.label === 'Revenue')!.figures.actual!;
    expect(revenue.value).toBe(4_200_000);
    expect(formatFigureText(revenue, scale!)).toBe('4 200');
  });

  it('keeps every model figure RAW, so no display scale reaches the integrity gate', () => {
    const recorded = doc.provenance.all().get('packFigureSet.current.revenue')!;
    expect(recorded.length).toBeGreaterThan(0);
    expect(recorded.every((f) => f.value === 4_200_000)).toBe(true);
  });

  it('states its scale in every table header', () => {
    for (const page of doc.pages) {
      for (const block of page.blocks) {
        if (block.kind === 'table') expect(block.table.scale, `page ${page.number}`).toBe(doc.numberConvention.scale);
      }
    }
  });

  // Brightsphere's net-debit revenue drove `debtorDays` negative and printed
  // "-4 days". Nothing inspected a tile VALUE, only counts and nullness of
  // deltas, which is why it shipped.
  it('prints no figure whose value is an artefact of an impossible base', () => {
    const doc2 = buildBoardPackPages(brightsphereInput);
    const tiles = doc2.pages.find((p) => p.number === 3)!.blocks
      .flatMap((b) => (b.kind === 'kpiTiles' ? b.tiles : []));
    for (const label of ['Debtor days', 'Debt-to-equity', 'Gross margin']) {
      const tile = tiles.find((t) => t.label === label)!;
      expect(tile.figure.value, label).toBeNull();
      expect(tile.figure.unavailable, label).toBeTruthy();
    }
    // And nothing anywhere in the pack reports a negative day count.
    for (const list of doc2.provenance.all().values()) {
      for (const figure of list) {
        if (figure.format === 'days' && figure.value !== null) {
          expect(figure.value, figure.source).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  it('foots the profit bridge on its own endpoints', () => {
    const chart = doc.pages.find((p) => p.number === 6)!.blocks
      .flatMap((b) => (b.kind === 'chart' ? [b.chart] : []))[0]!;
    const bars = chart.waterfallBars!;
    expect(bars.length).toBeGreaterThan(3);
    expect(bars[0]!.kind).toBe('open');
    expect(bars[bars.length - 1]!.kind).toBe('close');
    expect(bars[bars.length - 1]!.end).toBe(demoSet.current.netProfit);
    // Every bar that is not a subtotal reset continues from the previous end.
    for (let i = 1; i < bars.length; i += 1) {
      if (bars[i]!.start !== 0) expect(bars[i]!.start, bars[i]!.label).toBe(bars[i - 1]!.end);
    }
  });

  it('closes the cash bridge on the closing balance, plug included', () => {
    const chart = doc.pages.find((p) => p.number === 8)!.blocks
      .flatMap((b) => (b.kind === 'chart' ? [b.chart] : []))[0]!;
    const bars = chart.waterfallBars!;
    expect(bars[0]!.end).toBe(demoSet.prior!.cash);
    expect(bars[bars.length - 1]!.end).toBe(demoSet.current.cash);
    // The last MOVEMENT bar must land exactly on the closing bar — that is
    // what the named "Unexplained movement" plug is for.
    expect(bars[bars.length - 2]!.end).toBe(demoSet.current.cash);
  });

  it('tells the reader the cash bridge carries an unexplained movement', () => {
    const notes = doc.pages.find((p) => p.number === 8)!.blocks
      .flatMap((b) => (b.kind === 'disclosure' ? b.disclosure.notes : []));
    expect(notes.some((n) => /not explained/i.test(n.body))).toBe(true);
  });

  it('draws the trends page as LINE panels at the half height', () => {
    const panels = doc.pages.find((p) => p.number === 10)!.blocks
      .flatMap((b) => (b.kind === 'smallMultiples' ? b.panels : []));
    expect(panels.length).toBeGreaterThan(0);
    expect(panels.every((p) => p.kind === 'line')).toBe(true);
    expect(panels.every((p) => p.heightMm === CHART_HEIGHT_MM.half)).toBe(true);
  });

  function disclosureHeadings(page: (typeof doc)['pages'][number]): string[] {
    return page.blocks.flatMap((b) => (b.kind === 'disclosure' ? [b.disclosure.heading] : []));
  }

  it('draws all six specified panels when every metric is meaningful, and says nothing about panels not drawn', () => {
    const panels = doc.pages.find((p) => p.number === 10)!.blocks
      .flatMap((b) => (b.kind === 'smallMultiples' ? b.panels : []));
    expect(panels.length).toBe(TRENDS_PANELS_SPECIFIED);
    expect(disclosureHeadings(doc.pages.find((p) => p.number === 10)!)).not.toContain('Panels not drawn');
  });

  it('draws fewer than six panels when a metric is not meaningful all period, and discloses which count is short', () => {
    const shortDoc = buildBoardPackPages(noRatioPanelsInput);
    const page10 = shortDoc.pages.find((p) => p.number === 10)!;
    const panels = page10.blocks.flatMap((b) => (b.kind === 'smallMultiples' ? b.panels : []));
    expect(panels.length).toBeLessThan(TRENDS_PANELS_SPECIFIED);
    expect(disclosureHeadings(page10)).toContain('Panels not drawn');
  });

  it('draws the page-8 closing-cash line from the trend, and it foots on the closing cash figure', () => {
    const chart = doc.pages.find((p) => p.number === 8)!.blocks
      .flatMap((b) => (b.kind === 'chart' ? [b.chart] : []))
      .find((c) => c.id === 'cash-trend')!;
    expect(chart).toBeDefined();
    expect(chart.kind).toBe('line');
    // One vertex per trend period — a structural count, not `svg.length > 0`.
    const seriesPath = chart.svg.match(/stroke="#15202b" stroke-width="2"[^>]*d="([^"]+)"/)
      ?? chart.svg.match(/d="([^"]+)"[^>]*stroke="#15202b" stroke-width="2"/);
    const points = seriesPath![1]!.split(/[ML]/).filter((s) => s.trim() !== '');
    expect(points).toHaveLength(trend.length);
    // The closing value is labelled directly on the chart (spec §4.A's
    // end-labelled small multiple), so the figure itself is checkable in the
    // SVG, not just in the title string.
    expect(chart.svg).toContain(formatMoney(trend[trend.length - 1]!.cash));
    expect(disclosureHeadings(doc.pages.find((p) => p.number === 8)!)).not.toContain('No closing-cash series');
  });

  it('discloses why there is no closing-cash line when there is no trend series at all', () => {
    const doc2 = buildBoardPackPages(brightsphereInput);
    const page8 = doc2.pages.find((p) => p.number === 8)!;
    const chartIds = page8.blocks.flatMap((b) => (b.kind === 'chart' ? [b.chart.id] : []));
    expect(chartIds).not.toContain('cash-trend');
    expect(disclosureHeadings(page8)).toContain('No closing-cash series');
  });

  it('never restates a page title as that page\'s commentary', () => {
    for (const source of [doc, buildBoardPackPages(brightsphereInput)]) {
      for (const page of source.pages) {
        for (const block of page.blocks) {
          if (block.kind !== 'disclosure') continue;
          for (const item of block.disclosure.notes) {
            expect(item.body.trim(), `page ${page.number}`).not.toBe(page.title.trim());
          }
        }
      }
    }
  });

  it('points every sparkline tile at a real footnote on its own page', () => {
    const highlights = doc.pages.find((p) => p.number === 3)!;
    const numbers = new Set(highlights.footnotes.map((f) => f.number));
    expect(numbers.size).toBeGreaterThan(0);
    const tiles = highlights.blocks.flatMap((b) => (b.kind === 'kpiTiles' ? b.tiles : []));
    for (const tile of tiles) {
      if (tile.sparklineSvg !== null) expect(numbers.has(tile.trendFootnote!), tile.label).toBe(true);
      else expect(tile.trendFootnote, tile.label).toBeNull();
    }
  });

  // `ReportPackInput.operatingProfit` is OPTIONAL, so undefined is
  // type-reachable. Page 3 read it as null-with-a-reason and the statement
  // tables read the classifier's documented fallback — against the SAME
  // provenance source. Two readings of one source throws in
  // `assertConsistent`, which takes the whole render with it: the pack does
  // not fail a cell, it fails to exist.
  it('renders when the classifier supplied no operating profit line', () => {
    const noOperatingLine = buildBoardPackPages({
      ...demoInput,
      set: {
        ...demoSet,
        current: figures({ operatingProfit: undefined }),
        prior: figures({ revenue: 3_750_000, netProfit: 388_000, operatingProfit: undefined }),
      },
    });
    expect(() => noOperatingLine.provenance.assertConsistent()).not.toThrow();
    expect(noOperatingLine.pages).toHaveLength(12);
    const readings = noOperatingLine.provenance.all().get('packMetricReads.operatingProfit')!;
    expect(readings.length).toBeGreaterThan(1);
    expect(new Set(readings.map((f) => f.value)).size).toBe(1);
    expect(readings[0]!.value).not.toBeNull();
  });

  // Capital expenditure is optional on `ReportPackInput`. Zeroing it reports
  // a company that bought nothing, which is a statement about the business
  // rather than about our data — and the two cash rows beside it already say
  // "not captured" when their own figure is absent (R-P44/R-P45).
  it('says capital expenditure was not captured rather than reporting zero investing', () => {
    const noCapex = buildBoardPackPages({
      ...demoInput,
      set: { ...demoSet, current: figures({ capitalExpenditure: undefined }) },
    });
    const table = noCapex.pages.find((p) => p.number === 8)!.blocks
      .flatMap((b) => (b.kind === 'table' ? [b.table] : []))[0]!;
    const investing = table.rows.find((r) => r.label === 'Investing cash flow')!.figures.actual!;
    expect(investing.value).toBeNull();
    expect(investing.unavailable).toMatch(/capital expenditure/i);
  });

  // THE ASSERTION SHAPE NOTHING HAD: a page title read against the figure
  // printed beside it. The first fix for the operating-line defect turned a
  // loud render failure into a silent contradiction — page 3's title said
  // "Operating margin is 0.0%" beside a tile showing 750 000, and page 5's
  // said "operating profit of 512 000" above a row showing 750 000, because
  // two sentences still read the raw optional field with their own fallbacks.
  it('agrees with the figure beside it in the titles of pages 3 and 5', () => {
    const noOperatingLine = buildBoardPackPages({
      ...demoInput,
      set: { ...demoSet, current: figures({ operatingProfit: undefined }) },
    });
    const tile = noOperatingLine.pages.find((p) => p.number === 3)!.blocks
      .flatMap((b) => (b.kind === 'kpiTiles' ? b.tiles : []))
      .find((t) => t.label === 'Operating profit')!;
    const row = noOperatingLine.pages.find((p) => p.number === 5)!.blocks
      .flatMap((b) => (b.kind === 'table' ? b.table.rows : []))
      .find((r) => r.label === 'Operating profit')!;

    expect(tile.figure.value).not.toBeNull();
    expect(row.figures.actual!.value).toBe(tile.figure.value);

    // Page 5's title states the operating profit. It must be THAT number.
    expect(noOperatingLine.pages.find((p) => p.number === 5)!.title)
      .toContain(formatMoney(tile.figure.value!));

    // Page 3's title states the operating margin. It must be THAT number over
    // this period's revenue, not a margin taken on a defaulted zero.
    const margin = marginPct(tile.figure.value!, demoSet.current.revenue)!;
    expect(noOperatingLine.pages.find((p) => p.number === 3)!.title)
      .toContain(formatPctMagnitude(margin));
  });

  it('tells the reader that rounded components may not add to the totals', () => {
    for (const number of [5, 6, 7, 8]) {
      const page = doc.pages.find((p) => p.number === number)!;
      expect(page.footnotes.some((f) => /may not add/i.test(f.text)), `page ${number}`).toBe(true);
    }
    const basis = doc.pages.find((p) => p.number === 12)!.blocks
      .flatMap((b) => (b.kind === 'disclosure' ? b.disclosure.notes : []));
    expect(basis.some((n) => /may not add/i.test(n.body))).toBe(true);
  });

  it('draws no cash-bridge bar for a category the figure set never captured', () => {
    const noCapex = buildBoardPackPages({
      ...demoInput,
      set: { ...demoSet, current: figures({ capitalExpenditure: undefined }) },
    });
    const chart = noCapex.pages.find((p) => p.number === 8)!.blocks
      .flatMap((b) => (b.kind === 'chart' ? [b.chart] : []))[0]!;
    const labels = chart.waterfallBars!.map((b) => b.label);
    // The table one block above says capital expenditure was not captured;
    // a flat Investing bar here would be the same figure telling two stories.
    expect(labels).not.toContain('Investing');
    expect(labels).toContain('Unexplained movement');
    // And the bridge still foots on the closing balance.
    expect(chart.waterfallBars![chart.waterfallBars!.length - 1]!.end).toBe(demoSet.current.cash);
  });

  it('records every figure it renders in the provenance map', () => {
    expect(() => doc.provenance.assertConsistent()).not.toThrow();
    expect([...doc.provenance.all().keys()].length).toBeGreaterThan(30);
  });

  it('keeps the provenance of the hostile case consistent too', () => {
    const doc2 = buildBoardPackPages(brightsphereInput);
    expect(() => doc2.provenance.assertConsistent()).not.toThrow();
    expect([...doc2.provenance.all().keys()].length).toBeGreaterThan(30);
  });
});
