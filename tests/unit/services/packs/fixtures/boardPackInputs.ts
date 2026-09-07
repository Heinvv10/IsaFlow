/**
 * The two board pack inputs every pack test composes from, moved out of
 * `boardPackPages.test.ts` so the RENDERER test
 * (tests/unit/components/packs/boardPackRender.test.tsx) drives the same
 * documents the composer test does. A second, hand-copied fixture would let
 * the two drift, and the renderer would then be proved against a pack shape
 * the composer no longer builds.
 *
 * Nothing here changed in the move — same values, same comments.
 *
 * `demoInput` is a healthy company with a prior period and a budget; it can
 * only ever exercise the happy path. `brightsphereInput` mirrors the real
 * client: negative revenue, negative equity, no prior period, no budget, and
 * no approved commentary on either narrative page.
 */
import type { BoardPackInput } from '@/modules/accounting/services/packs/pages/boardPackPages';
import type { PackFigureSet } from '@/modules/accounting/services/packs/figures/packFigureSet';
import type { ReportPackFigures } from '@/modules/accounting/services/reports/reportPackDataService';
import type { PackTrendPoint } from '@/modules/accounting/services/packs/packTrendService';
import type { PackMatter } from '@/modules/accounting/services/packs/pages/packMatters';
import type { PackBrand } from '@/modules/accounting/services/packs/packBrand';

export function figures(overrides: Partial<ReportPackFigures>): ReportPackFigures {
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

/**
 * A thirteen-month series whose LAST cash point is the closing cash of the
 * pack it belongs to.
 *
 * It has to be a function of that figure. Page 8 carries both the cash table
 * (closing cash from `PackFigureSet.current.cash`) and the closing-cash line
 * drawn from this series, and a fixture whose series ends somewhere else is a
 * fixture in which the pack states one quantity twice at two values —
 * precisely the defect `checkChartClaims` now refuses, and precisely what the
 * rendered pack did on paper. The two are the same position measured at the
 * same date; they cannot be invented independently.
 */
export function trendEndingAt(closingCash: number): PackTrendPoint[] {
  return Array.from({ length: 13 }, (_, i) => trendPoint(i, closingCash));
}

function trendPoint(i: number, closingCash: number): PackTrendPoint {
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
    cash: closingCash - (12 - i) * 5_000,
    accountsReceivable: 700_000 + i * 4_000,
    debtorDays: Math.round(((700_000 + i * 4_000) / revenue) * 30 * 100) / 100,
  };
}

/** The demo company's series — `demoSet.current.cash` is 610 000. */
export const trend: PackTrendPoint[] = trendEndingAt(610_000);

/**
 * Every month has zero revenue, so `grossMarginPct` and `debtorDays` are both
 * not-meaningful (R-P44/R-P45) throughout — the only fixture in this file
 * that genuinely produces FEWER than the six specified panels. Money panels
 * (revenue, operating expenses, net profit, cash) still draw fine: none of
 * them needs a positive revenue.
 */
export const zeroRevenueTrend: PackTrendPoint[] = trend.map((point) => ({
  ...point,
  revenue: 0,
  grossMarginPct: null,
  debtorDays: null,
}));

export const brand: PackBrand = {
  primaryColour: '#1f4e79',
  secondaryColour: '#c8a86b',
  logoUrl: null,
  footerText: null,
  primaryInk: '#ffffff',
};

export const matters: PackMatter[] = [
  {
    issue: 'Aged debtor concentration: Acme Holdings is 34.0% of total debtors owed',
    quantum: 244_800,
    owner: 'Credit control',
    movement: 'Not tracked — no prior board pack is stored to compare against.',
    decisionRequired: 'Approve escalation, a credit hold, or a write-off review for this account.',
  },
];

export const demoSet: PackFigureSet = {
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

export const demoInput: BoardPackInput = {
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
export const noRatioPanelsInput: BoardPackInput = { ...demoInput, trend: zeroRevenueTrend };

/**
 * Brightsphere: negative revenue, negative equity, no prior, no budget, and
 * no approved commentary on either narrative page.
 */
export const brightsphereSet: PackFigureSet = {
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

export const brightsphereInput: BoardPackInput = {
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

/**
 * THE PACK THE FIRST RENDERED PROOF ACTUALLY PRINTED — the shape that turned
 * twelve model pages into nineteen sheets of paper.
 *
 * `demoInput` and `brightsphereInput` are both SPARSE, and neither can reach
 * the failure. What made the real ISAFlow Demo pack overflow was density, in
 * two places at once:
 *
 *   1. A prior period whose revenue is NOT a positive base. Every `changePct`
 *      cell then holds `packStatementTables`' "The prior figure is not a
 *      positive base…" sentence instead of a percentage — a three-line
 *      paragraph in a numeric column, on every row of four statement tables.
 *      That alone roughly doubled the height of pages 5 to 8.
 *   2. Fifteen matters. `buildMatters` returns one row per unusual journal it
 *      finds and the real company had fifteen; the table ran across three
 *      sheets. Both other fixtures carry exactly one matter.
 *
 * The figures are the rendered pack's own, from `evidence/board-demo.pdf`.
 * They are here so a fix is proved against the document that failed rather
 * than against a fixture chosen for being easy to lay out.
 */
export const denseSet: PackFigureSet = {
  current: figures({
    revenue: 98_800,
    costOfSales: 1_430_581,
    operatingExpenses: 225_571,
    otherIncome: 11_812,
    otherExpenses: 0,
    operatingProfit: -1_545_540,
    netProfit: -1_545_540,
    totalAssets: 1_280_063,
    totalLiabilities: 5_368_357,
    totalEquity: -4_088_294,
    currentAssets: 1_180_063,
    currentLiabilities: 5_002_413,
    cash: -532_332,
    accountsReceivable: 620_400,
    accountsPayable: 3_120_800,
    inventory: 0,
    operatingCashFlow: -407_476,
    capitalExpenditure: 0,
    financingCashFlow: 0,
  }),
  currentWindow: { start: '2026-01-01', end: '2026-09-07' },
  // Revenue of zero is not a positive base, so no row on any statement can
  // state a percentage change — which is exactly the case that fills the
  // change column with prose.
  prior: figures({
    revenue: 0,
    costOfSales: 805_000,
    operatingExpenses: 112_000,
    otherIncome: 12_000,
    otherExpenses: 0,
    operatingProfit: -905_000,
    netProfit: -905_000,
    totalAssets: 940_000,
    totalLiabilities: 3_880_000,
    totalEquity: -2_940_000,
    currentAssets: 860_000,
    currentLiabilities: 3_640_000,
    cash: -124_856,
    accountsReceivable: 410_000,
    accountsPayable: 2_240_000,
    inventory: 0,
    operatingCashFlow: -260_000,
    capitalExpenditure: 0,
    financingCashFlow: 0,
  }),
  priorWindow: { start: '2025-04-26', end: '2025-12-31' },
  budget: null,
};

/** Fifteen unusual-journal matters, worded as `buildMatters` words them. */
export const denseMatters: PackMatter[] = Array.from({ length: 15 }, (_, i) => ({
  issue: `Journal JE-2026-000${String(i + 61).padStart(2, '0')} (recorded well after its entry date): Payroll run 2026-0${(i % 9) + 1}`,
  quantum: 340_000 - i * 21_000,
  owner: 'Finance',
  movement: 'Not tracked — no prior board pack is stored to compare against.',
  decisionRequired: 'Confirm supporting evidence for this entry or refer it for reversal.',
}));

export const denseInput: BoardPackInput = {
  ...demoInput,
  period: '1 January 2026 to 7 September 2026',
  draft: true,
  set: denseSet,
  // Its own closing cash, not the demo company's — see `trendEndingAt`.
  trend: trendEndingAt(denseSet.current.cash),
  matters: denseMatters,
  // Nothing in this codebase stores board-matter commentary, so the real pack
  // printed the pending placeholder on page 11 — and page 4's commentary was
  // unapproved too. Both placeholders, as they actually rendered.
  commentary: null,
  mattersCommentary: null,
};

/**
 * Locating a page in a pack whose page NUMBERS depend on its data.
 *
 * The narrative page merges into its neighbour when no commentary has been
 * approved (spec §5.7), so a spec page number — "page 8 is cash" — is not an
 * index into `doc.pages` for every company. These find a page by what it
 * CARRIES, which is stable, and they exist so a test asserting something
 * about the cash page keeps asserting it about the cash page.
 */
export function pageWithTableRow(
  doc: { pages: Array<{ blocks: unknown[] }> },
  label: string,
) {
  return doc.pages.find((page) =>
    page.blocks.some((block) => {
      const b = block as { kind: string; table?: { rows: Array<{ label: string }> } };
      return b.kind === 'table' && (b.table?.rows ?? []).some((r) => r.label === label);
    }),
  );
}

/** The basis of preparation, which is the pack's last page by construction. */
export function basisPage<T>(doc: { pages: T[] }): T {
  return doc.pages[doc.pages.length - 1]!;
}
