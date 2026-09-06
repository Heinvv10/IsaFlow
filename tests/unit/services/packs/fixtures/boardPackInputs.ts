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

export const trend: PackTrendPoint[] = Array.from({ length: 13 }, (_, i) => {
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
