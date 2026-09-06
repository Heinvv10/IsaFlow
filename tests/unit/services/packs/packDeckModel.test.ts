import { describe, it, expect } from 'vitest';
import { buildPackDeck } from '@/modules/accounting/services/packs/packDeckModel';
import type { DeckSlide, DeckTableSlide, DeckChartSlide } from '@/modules/accounting/services/packs/packDeckModel';
import { buildPackDocument, type PackDocument } from '@/modules/accounting/services/packs/packDocument';
import { buildReportPack, type ReportPackInput } from '@/modules/accounting/services/reports/reportPackService';
import type { PackTrendPoint } from '@/modules/accounting/services/packs/packTrendService';

const doc: PackDocument = {
  packType: 'management',
  companyName: 'ISAFlow Demo',
  period: '2026-01-01 to 2026-09-05',
  generatedAt: '2026-09-06T08:00:00.000Z',
  sections: [
    { type: 'income_statement', title: 'Statement of Comprehensive Income', landscape: false, blocks: [
      { kind: 'statement', rows: [
        { id: 'sec:revenue', kind: 'section', label: 'Revenue', depth: 0, actual: 4812345.67 },
        { id: 'sub:revenue', kind: 'subtotal', label: 'Turnover', depth: 0, actual: 4812345.67 },
        { id: 'grand:netProfit', kind: 'grand', label: 'Net Profit / (Loss)', depth: 0, actual: 1275632.74 },
      ] },
      { kind: 'kv', items: [{ label: 'Gross Margin', value: 54.5, format: 'pct' }] },
    ] },
    { type: 'waterfall', title: 'Profit Bridge', landscape: true, blocks: [
      { kind: 'waterfall', steps: [
        { label: 'Revenue', start: 0, end: 4812345.67, value: 4812345.67, isSubtotal: false, color: 'green' },
        { label: 'Cost of Sales', start: 4812345.67, end: 2622345.67, value: -2190000, isSubtotal: false, color: 'red' },
      ] },
    ] },
  ],
};

const table = (slides: DeckSlide[]): DeckTableSlide =>
  slides.find((s): s is DeckTableSlide => s.kind === 'table')!;

describe('buildPackDeck', () => {
  it('opens with a title slide naming the company, the pack and the period', () => {
    const [first] = buildPackDeck(doc);
    expect(first).toEqual({
      kind: 'title', title: 'ISAFlow Demo', subtitle: 'Management Pack', footnote: '2026-01-01 to 2026-09-05',
    });
  });

  it('turns a statement into a table of formatted figures', () => {
    const slides = buildPackDeck(doc);
    expect(table(slides).title).toBe('Statement of Comprehensive Income');
    expect(table(slides).rows.map((r) => r.label)).toContain('Turnover');
    expect(table(slides).rows.find((r) => r.label === 'Net Profit / (Loss)')!.emphasis).toBe(true);
  });

  it('formats table figures with formatMoney, cents included', () => {
    const netProfit = table(buildPackDeck(doc)).rows.find((r) => r.label === 'Net Profit / (Loss)')!.value;
    expect(netProfit).toMatch(/^1\D?275\D?632\.74$/);
  });

  it('drops band-header rows, which carry a figure the subtotal already prints', () => {
    expect(table(buildPackDeck(doc)).rows.map((r) => r.label)).not.toContain('Revenue');
  });

  it('gives PowerPoint the RAW numbers so the chart stays editable', () => {
    const slides = buildPackDeck(doc);
    const chart = slides.find((s): s is DeckChartSlide => s.kind === 'chart')!;
    expect(chart.categories).toEqual(['Revenue', 'Cost of Sales']);
    expect(chart.series[0]!.values).toEqual([4812345.67, -2190000]);
  });

  it('formats a percentage as a percentage', () => {
    const rows = buildPackDeck(doc).flatMap((s) => (s.kind === 'table' ? s.rows : []));
    expect(rows.find((r) => r.label === 'Gross Margin')!.value).toBe('+54.5%');
  });

  it('prints a KV item reason INSTEAD of a figure when the figure is unavailable', () => {
    const withReason: PackDocument = {
      ...doc,
      sections: [{ type: 'ratios', title: 'Financial Ratios', landscape: false, blocks: [
        { kind: 'kv', items: [{ label: 'Return On Equity', value: null, format: 'pct', unavailable: 'Not meaningful' }] },
      ] }],
    };
    const rows = buildPackDeck(withReason).flatMap((s) => (s.kind === 'table' ? s.rows : []));
    expect(rows[0]!.value).toBe('Not meaningful');
  });

  it('prints a scorecard item reason INSTEAD of a score when the ratio is not meaningful', () => {
    const scorecard: PackDocument = {
      ...doc,
      sections: [{ type: 'kpis', title: 'KPI Scorecard', landscape: false, blocks: [
        { kind: 'scorecard', items: [
          { ratioKey: 'currentRatio', name: 'Current Ratio', value: 2.32, target: 2, status: 'green', percentOfTarget: 116 },
          { ratioKey: 'returnOnEquity', name: 'Return On Equity', value: null, target: 15, status: 'not_meaningful', reason: 'Equity is not positive', percentOfTarget: 0 },
        ] },
      ] }],
    };
    const rows = buildPackDeck(scorecard).flatMap((s) => (s.kind === 'table' ? s.rows : []));
    expect(rows[0]!.value).toBe('2.32 / 2');
    expect(rows[1]!.value).toBe('Equity is not positive');
  });

  it('carries a text block through as its own slide', () => {
    const commentary: PackDocument = {
      ...doc,
      sections: [{ type: 'commentary', title: 'Commentary', landscape: false, blocks: [{ kind: 'text', text: 'Revenue grew.' }] }],
    };
    expect(buildPackDeck(commentary)[1]).toEqual({ kind: 'text', title: 'Commentary', body: 'Revenue grew.' });
  });

  it('plots the twelve-month trend as revenue, the series the screen plots', () => {
    const points: PackTrendPoint[] = [
      {
        month: '2026-08', label: 'Aug 2026', revenue: 400000, expenses: 300000, netProfit: 100000,
        costOfSales: 180000, operatingExpenses: 120000, grossMarginPct: 55,
        cash: 250000, accountsReceivable: 90000, debtorDays: 6.75,
      },
    ];
    const trendDoc: PackDocument = {
      ...doc,
      sections: [{ type: 'trends', title: 'Twelve-Month Trend', landscape: true, blocks: [{ kind: 'trend', points }] }],
    };
    const chart = buildPackDeck(trendDoc).find((s): s is DeckChartSlide => s.kind === 'chart')!;
    expect(chart.categories).toEqual(['Aug 2026']);
    expect(chart.series).toEqual([{ name: 'Revenue', values: [400000] }]);
  });
});

// ---------------------------------------------------------------------------
// The deck must not invent a figure. Same guarantee packDocument.test.ts makes
// of the document, made again one layer down: the deck is where a renderer is
// most tempted to sum a column "so the slide has a total".
// ---------------------------------------------------------------------------

const INPUT: ReportPackInput = {
  companyName: 'ISAFlow Demo', period: '2026-01-01 to 2026-09-05',
  revenue: 4812345.67, costOfSales: 2190000, operatingExpenses: 1400000, netProfit: 1275632.74,
  totalAssets: 8200000, totalLiabilities: 3100000, totalEquity: 5100000,
  currentAssets: 4400000, currentLiabilities: 1900000, cash: 1250000,
  accountsReceivable: 2100000, accountsPayable: 900000, inventory: 350000,
  otherIncome: 53787.07, otherExpenses: 0, operatingProfit: 1275632.74,
};

const TREND: PackTrendPoint[] = [
  {
    month: '2026-08', label: 'Aug 2026', revenue: 400000, expenses: 300000, netProfit: 100000,
    costOfSales: 180000, operatingExpenses: 120000, grossMarginPct: 55,
    cash: 250000, accountsReceivable: 90000, debtorDays: 6.75,
  },
  {
    month: '2026-09', label: 'Sep 2026', revenue: 420000, expenses: 310000, netProfit: 110000,
    costOfSales: 185000, operatingExpenses: 125000, grossMarginPct: 55.95,
    cash: 260000, accountsReceivable: 95000, debtorDays: 6.79,
  },
];

function numbersIn(value: unknown, found: Set<number> = new Set()): Set<number> {
  if (typeof value === 'number') { found.add(value); return found; }
  if (Array.isArray(value)) { value.forEach((v) => numbersIn(v, found)); return found; }
  if (value && typeof value === 'object') { Object.values(value).forEach((v) => numbersIn(v, found)); return found; }
  return found;
}

/**
 * Every figure a formatted deck cell PRINTS, with the precision it printed at.
 * formatMoney separates thousands with a space and wraps a negative in
 * parentheses; formatPct signs it and rounds to one decimal. The separators
 * are stripped so what is compared is the figure a reader reads.
 */
function figuresInText(text: string): Array<{ value: number; tolerance: number }> {
  const negative = text.trim().startsWith('(') || text.includes('\u2212');
  const bare = text.replace(/[\s\u00a0\u202f]/g, '');
  return [...bare.matchAll(/\d+(?:\.(\d+))?/g)].map((m) => {
    const decimals = m[1]?.length ?? 0;
    const value = Number(m[0]);
    return { value: negative ? -value : value, tolerance: 0.5 / 10 ** decimals };
  });
}

/** A printed figure is explained when SOME pack figure rounds to it at the
 *  precision it was printed at. Comparing exactly would fail on "+54.5%",
 *  which is a one-decimal rounding of the pack's own 54.49. */
function isExplained(printed: { value: number; tolerance: number }, allowed: number[]): boolean {
  // `<=`, because a half-way figure rounds AWAY from zero: the pack's own
  // 20.25 prints as "+20.3%", exactly one tolerance out.
  const near = (a: number) => Math.abs(a - printed.value) <= printed.tolerance + 1e-9;
  return allowed.some((a) => near(a) || near(-a));
}

describe('buildPackDeck INVENTS NO FIGURE', () => {
  it('prints only numbers the pack itself produced', () => {
    const pack = buildReportPack('management', INPUT, '2026-01-01', '2026-09-05');
    const deck = buildPackDeck(buildPackDocument(pack, TREND));

    const allowed = numbersIn(pack.sections.map((s) => s.data));
    numbersIn(TREND).forEach((n) => allowed.add(n));
    // The one documented exception, inherited from ManagementBalanceSheetRows.
    allowed.add(INPUT.totalLiabilities + INPUT.totalEquity);
    // A KPI scorecard cell reads "<value> / <target>"; the target is a policy
    // constant off the scorecard item, not a figure the deck derived.
    numbersIn(pack.sections.flatMap((s) => (s.data.scorecard as unknown[] | undefined) ?? [])).forEach((n) => allowed.add(n));
    // Structure, not figures.
    [0, 1].forEach((n) => allowed.add(n));

    const printed = deck.flatMap((slide) => {
      if (slide.kind === 'table') return slide.rows.flatMap((r) => figuresInText(r.value));
      // A chart carries the raw figure, so it must match EXACTLY.
      if (slide.kind === 'chart') return slide.series.flatMap((s) => s.values.map((v) => ({ value: v, tolerance: 0 })));
      return [];
    });

    const allowedList = [...allowed];
    const unexplained = printed.filter((n) => !isExplained(n, allowedList)).map((n) => n.value);
    expect(unexplained).toEqual([]);
  });
});
