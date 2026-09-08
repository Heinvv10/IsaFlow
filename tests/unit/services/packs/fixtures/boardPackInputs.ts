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
import { BOARD_DECISIONS } from '@/modules/accounting/services/packs/pages/packMatterDecisions';
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
    // 4 200 − 2 310 − 1 180 + 40. `aggregateFigures` computes the operating
    // line WITHOUT other expenses — `netProfit = operatingProfit −
    // otherExpenses` is the next line of it — and this fixture carried
    // 735 000, which is that figure with the 15 000 of other expenses already
    // taken off. A fixture that models the classifier's output has to model
    // its arithmetic, or a statement that does not foot as laid out passes.
    operatingProfit: 750_000,
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
    // A real charge, so the fixtures exercise the EBITDA add-back rather
    // than a nil one that any implementation would satisfy.
    depreciation: 96_000,
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
    // WHOLE MONTHS. `partialMonthOf` reads this, and a fixture that left it
    // undefined would exercise the un-marked path by accident on every test
    // in the suite. The mid-month case has its own fixture —
    // `packPartialMonth.test.ts`.
    partial: false,
    daysCovered: 31,
    daysInMonth: 31,
    revenue,
    otherIncome: 0,
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
    // `kind` was missing from every matter in this file, and `PackMatter`
    // requires it: `tests/**` is outside `tsconfig`, so `tsc --noEmit` never
    // saw these objects. It is not decoration — `mattersTitle` counts
    // `kind === 'finding'` and `kind === 'checkFailed'`, so page 11 of the
    // demo pack was headlined "0 matters require a board decision this
    // period. Every check ran clean." over a table listing one matter and
    // 245 of exposure. See `tsconfig.packfixtures.json`.
    kind: 'finding',
    issue: "Aged debtor concentration: Acme Holdings owes 245, 34.0% of all debtors owed, which come to 720, in R'000",
    quantum: 244_800,
    owner: 'Credit control',
    movement: 'Not tracked — no prior board pack is stored to compare against.',
    decisionRequired: BOARD_DECISIONS.agedDebtorConcentration,
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
  // FINAL: the period is closed AND a human approved commentary. Both, and
  // never a boolean — see `packDraftStatus.ts`.
  draftReasons: [],
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
  // The shape `getLedgerPostedThrough` actually returns — an ISO timestamp.
  // It was a made-up `posted-through 2026-08-31`, which is the only reason
  // every fixture built a page 12 carrying a bare ISO date in a sentence.
  ledgerVersion: '2026-08-31T10:00:00.000Z',
  // THE HEALTHY CASE, AND IT IS THE SAME NUMBER TWICE ON PURPOSE. This is the
  // base the concentration matter above states (720 in R'000), and
  // `demoSet.current.accountsReceivable` is 720 000 too — a company whose
  // subledger and control account agree. `receivablesReconciliationNote`
  // returns null on a nil difference, so this fixture is the proof that a
  // pack with two agreeing debtors figures prints no reconciliation and page
  // 11 loses no row to one.
  receivables: {
    agedDebtorsTotal: 720_000,
    subledgerTotal: 720_000,
    controlBalance: 720_000,
    items: [],
    unexplained: 0,
  },
};

/** Same as `demoInput` in every other respect, but its trend genuinely draws
 *  fewer than the six specified panels — see `zeroRevenueTrend`. */
export const noRatioPanelsInput: BoardPackInput = { ...demoInput, trend: zeroRevenueTrend };

/**
 * THE PACK THE GATE MUST REFUSE — and the reason it is a fixture rather than
 * a company.
 *
 * The refusal path was only ever proved against Brightsphere in
 * `isaflow_dev`, whose balance sheet was out by R450 because one journal line
 * pointed at another company's `gl_account`. Someone has since removed that
 * line: Brightsphere now foots, renders a full twelve-sheet pack, and the
 * only end-to-end evidence that spec §7.2 refuses anything went with it. A
 * fixture cannot be repaired out from under the suite.
 *
 * The break is modelled on that one exactly — assets R450 short of
 * liabilities plus equity, one cent being enough (`MONEY_TOLERANCE`) — and it
 * is applied to `totalAssets` rather than to equity so that the failure names
 * the identity a reader would recognise: the balance sheet does not foot.
 *
 * NOTHING ELSE IS CHANGED. A fixture broken in several places at once proves
 * only that the gate throws on something; the refusal message this pins is a
 * single, named, arithmetic failure.
 */
export const OUT_OF_BALANCE_BY = 450;

export const outOfBalanceInput: BoardPackInput = {
  ...demoInput,
  set: {
    ...demoSet,
    current: figures({
      totalAssets: demoSet.current.totalAssets - OUT_OF_BALANCE_BY,
      // Both halves of the asset side move with the total, so the ONLY
      // identity that breaks is the balance sheet's own. Leaving current
      // assets alone would additionally break "non-current assets = total
      // assets less current assets" and the message would carry two failures
      // where the fixture models one.
      currentAssets: demoSet.current.currentAssets - OUT_OF_BALANCE_BY,
    }),
  },
};

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
      kind: 'none',
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
  // No matter states a debtors total on this fixture — its `matters` is the
  // explicit "every check ran clean" row — so the pack prints one debtors
  // figure and there is nothing to reconcile. Its subledger agrees with its
  // control account, so page 4 states no debtors base either.
  receivables: {
    agedDebtorsTotal: null,
    subledgerTotal: 0,
    controlBalance: 0,
    items: [],
    unexplained: 0,
  },
};

/**
 * BRIGHTSPHERE AS THE LIVE TENANT ACTUALLY IS: WITH A COMPARATIVE PERIOD.
 *
 * `brightsphereInput` above carries `prior: null`, which is why it could not
 * reach the failure. The live company has a prior period and it is negative in
 * the same places the current one is — so every scorecard metric that cannot
 * be computed cannot be computed TWICE, once per column. When each prior
 * reason was qualified with "In the comparative period: " unconditionally,
 * that turned seven notes into fourteen, took the scorecard from 249.2mm to
 * 264.9mm on a 255mm sheet, and `fitPageToBox` refused the whole pack: the
 * company could not print a board pack at all.
 *
 * The figures are the dev tenant's own, read back from
 * `buildPackFigureSet(d27bac33…, 2026-01-01, 2026-09-07)`.
 */
export const brightspherePriorSet: PackFigureSet = {
  ...brightsphereSet,
  prior: figures({
    companyName: 'Brightsphere (Pty) Ltd',
    revenue: -2_100_000,
    costOfSales: 0,
    operatingExpenses: -1_400_000,
    operatingProfit: -700_000,
    netProfit: -700_000,
    totalAssets: 180_000,
    totalLiabilities: 420_000,
    totalEquity: -240_000,
    currentAssets: 90_000,
    currentLiabilities: 350_000,
    cash: 9_000,
    accountsReceivable: 55_000,
    accountsPayable: 190_000,
    inventory: 0,
    operatingCashFlow: 0,
    inventoryCaveat: 'No inventory accounts are classified, so a quick ratio has not excluded any.',
    classificationCaveat: null,
  }),
};

export const brightspherePriorInput: BoardPackInput = {
  ...brightsphereInput,
  set: brightspherePriorSet,
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
  kind: 'finding',
  issue: `Journal JE-2026-000${String(i + 61).padStart(2, '0')} (recorded well after its entry date): Payroll run 2026-0${(i % 9) + 1}`,
  quantum: 340_000 - i * 21_000,
  owner: 'Finance',
  movement: 'Not tracked — no prior board pack is stored to compare against.',
  decisionRequired: BOARD_DECISIONS.unusualJournal,
}));

export const denseInput: BoardPackInput = {
  ...demoInput,
  period: '1 January 2026 to 7 September 2026',
  draftReasons: ['openPeriod'],
  set: denseSet,
  // Its own closing cash, not the demo company's — see `trendEndingAt`.
  trend: trendEndingAt(denseSet.current.cash),
  matters: denseMatters,
  // NULL, AND NOT INHERITED FROM `demoInput`. `denseMatters` is fifteen
  // unusual journals and no concentration, so this pack prints no aged
  // debtors total and has one debtors figure to reconcile against nothing.
  // Inheriting the demo's 720 000 against `denseSet`'s own receivables would
  // put a reconciliation on the fixture that exists to fill page 11 with
  // rows — which is exactly the paper the reconciliation would take.
  receivables: {
    agedDebtorsTotal: null,
    subledgerTotal: denseSet.current.accountsReceivable,
    controlBalance: denseSet.current.accountsReceivable,
    items: [],
    unexplained: 0,
  },
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

/**
 * BRIGHTSPHERE AS THE LIVE ROUTE COMPOSED IT ON 2026-09-07 — the tenant that
 * could not be given a board pack at all.
 *
 * `brightspherePriorInput` above is the same company two rounds earlier and
 * its income statement measures 249.9mm, five millimetres inside the sheet,
 * so no fixture in the suite could see what the live route did:
 *
 *   fitPageToBox: "Income statement" needs 260.5mm and its sheet gives 255mm,
 *   with nothing left on it that may be dropped — every remaining note is one
 *   this pack is required to make.
 *
 * The eleven millimetres between them are ONE BLOCK: the derived caption.
 * This company's prior period carries no income at all, so every change cell
 * on the statement is prose rather than a percentage and the caption under
 * the chart reads "No line item on this page has a comparable percentage
 * change…" over three lines instead of one. Nothing about that was modelled,
 * because the earlier fixture was rounded off a figure set with a prior
 * period that had figures in it.
 *
 * So the whole sheet is here as the ledger gives it: negative revenue, which
 * brings the required "what this means" disclosure with it; a required
 * sign-flip footnote, which the fitter may not take; and a prior period of
 * zeroes, which is what makes the caption three lines. Every figure below is
 * `buildPackFigureSet('d27bac33…', '2026-01-01', '2026-09-07')`'s own output,
 * unrounded, read back from `isaflow_dev` on 2026-09-07.
 *
 * WHAT IT DOES NOT MODEL: the live tenant's thirty board matters. Page 11 is
 * budgeted separately (`mattersBudgetMm`) and had nothing to do with this
 * failure; the single matter carries over from `brightsphereInput`.
 */
export const brightsphereLiveSet: PackFigureSet = {
  current: figures({
    companyName: 'Brightsphere Technologies (Pty) Ltd',
    period: '2026-01-01 to 2026-09-07',
    revenue: -5_535_000,
    costOfSales: 0,
    operatingExpenses: -3_717_000,
    otherIncome: -1_000,
    otherExpenses: -411_237,
    operatingProfit: -1_819_000,
    netProfit: -1_407_763,
    totalAssets: 3_191_945.16,
    totalLiabilities: 5_368_200.63,
    totalEquity: -2_176_255.47,
    currentAssets: -3_372_178.7,
    currentLiabilities: 5_792_028.13,
    cash: -3_452_709.7,
    accountsReceivable: -329_700,
    accountsPayable: 0,
    inventory: 0,
    depreciation: -152_000,
    inventoryCaveat: 'No account in the chart of accounts is classified as inventory, so inventory '
      + 'could not be identified and the quick ratio does not exclude it: on these figures the '
      + 'quick ratio and the current ratio are the same number. Read it as a current ratio until '
      + 'the stock control account is classified.',
    classificationCaveat: null,
  }),
  currentWindow: { start: '2026-01-01', end: '2026-09-07' },
  // Every income line zero — not absent. This is the half of the fixture the
  // rounded one could not reach: `packStatementTables` fills the change
  // column with "The prior figure is not a positive base…" and
  // `largestMoverCaption` says no percentage change is meaningful, in three
  // lines.
  prior: figures({
    companyName: 'Brightsphere Technologies (Pty) Ltd',
    period: '2025-04-26 to 2025-12-31',
    revenue: 0,
    costOfSales: 0,
    operatingExpenses: 0,
    otherIncome: 0,
    otherExpenses: 0,
    operatingProfit: 0,
    netProfit: 0,
    totalAssets: 6_554_795.16,
    totalLiabilities: 7_323_287.63,
    totalEquity: -768_492.47,
    currentAssets: 142_671.3,
    currentLiabilities: 7_747_115.13,
    cash: -267_109.7,
    accountsReceivable: 0,
    accountsPayable: 0,
    inventory: 0,
    depreciation: 0,
    inventoryCaveat: 'No account in the chart of accounts is classified as inventory, so inventory '
      + 'could not be identified and the quick ratio does not exclude it: on these figures the '
      + 'quick ratio and the current ratio are the same number. Read it as a current ratio until '
      + 'the stock control account is classified.',
    classificationCaveat: null,
  }),
  priorWindow: { start: '2025-04-26', end: '2025-12-31' },
  budget: null,
};

/**
 * The twelve months `getPackTrend` returns for that window.
 *
 * ONE MONTH CARRIES THE WHOLE PERIOD and every gross margin is null — the
 * company's revenue is in net debit, so no month has a positive base to
 * measure a margin against and the trends page draws no gross-margin panel.
 * That is what decides whether page 6 carries the cross-reference footnote,
 * so a fixture that invented a margin series would be testing the other
 * branch of the failure.
 */
export const brightsphereLiveTrend: PackTrendPoint[] = [
  'Oct 2025', 'Nov 2025', 'Dec 2025', 'Jan 2026', 'Feb 2026', 'Mar 2026',
  'Apr 2026', 'May 2026', 'Jun 2026', 'Jul 2026', 'Aug 2026', 'Sep 2026',
].map((label, i) => {
  const trading = i === 6;
  const opened = i >= 6;
  // The reporting date is 7 September 2026, so the last of the twelve months
  // is a seven-day stub — see `liveDemoTrend` for what the fixture was hiding
  // by leaving these three fields off.
  const daysInMonth = [31, 30, 31, 31, 28, 31, 30, 31, 30, 31, 31, 30][i]!;
  const partial = i === 11;
  return {
    month: `${label.slice(4)}-${String(((i + 9) % 12) + 1).padStart(2, '0')}`,
    label,
    partial,
    daysCovered: partial ? 7 : daysInMonth,
    daysInMonth,
    // TURNOVER AND OTHER INCOME AS THE LIVE TENANT CARRIES THEM: the ledger
    // holds (5 535 000) on the turnover account and (1 000) on other income.
    // The fixture used to carry the unbanded (5 536 000) as `revenue`, which
    // is the figure sheet 5 printed against sheet 6's (5 535).
    revenue: trading ? -5_535_000 : 0,
    otherIncome: trading ? -1_000 : 0,
    expenses: trading ? -4_128_237 : 0,
    netProfit: trading ? -1_407_763 : 0,
    costOfSales: 0,
    operatingExpenses: trading ? -3_717_000 : 0,
    grossMarginPct: null,
    cash: opened ? -3_452_709.7 : -267_109.7,
    accountsReceivable: opened ? -329_700 : 0,
    debtorDays: null,
  };
});

export const brightsphereLiveInput: BoardPackInput = {
  ...brightsphereInput,
  companyLegalName: 'Brightsphere Technologies (Pty) Ltd',
  period: '1 January 2026 to 7 September 2026',
  draftReasons: ['unapprovedCommentary'],
  set: brightsphereLiveSet,
  trend: brightsphereLiveTrend,
  // THE LIVE TENANT'S OWN WATERMARK, four and a half months before the
  // period end. `getLedgerPostedThrough` returns this exact timestamp for
  // Brightsphere over 1 January to 7 September 2026, and it is the fact
  // page 4's ledger-currency note is derived from: the May–September rows of
  // `brightsphereLiveTrend` are nil because nothing has been posted since,
  // and until this fixture carried the timestamp no test could tell that
  // shape from a company that genuinely stopped trading. `null` here — which
  // it inherited — is the "no posted journal was read at all" case, and
  // `brightsphereInput` still covers it.
  ledgerVersion: '2026-04-29T10:39:11.480Z',
};

/**
 * THE SHEET THE FOURTEENTH GATE REFUSED TO SEND, WITH THE TWO FIGURES THAT
 * MADE IT REFUSE.
 *
 * `brightsphereLiveInput` carries the live tenant's figures and the "every
 * check ran clean" matters row, so it exercises page 11's empty shape. The
 * live pack's page 11 is the opposite: thirty matters, headed by a named
 * counterparty owing 3 192 of an aged debtors report totalling 4 146, printed
 * on the sheet facing a balance sheet stating trade receivables of (330).
 * Both of those figures are real — 4 145 971.50 off `getAgingReport`, and
 * `brightsphereLiveSet.current.accountsReceivable` is the ledger's own
 * (329 700) — and their difference is what
 * `receivablesReconciliationNote` exists to print.
 *
 * It is a fixture of its own rather than a change to the one above because
 * that one is the page-11-with-nothing-on-it case and something has to keep
 * covering it.
 */
export const brightsphereReceivablesGapInput: BoardPackInput = {
  ...brightsphereLiveInput,
  matters: [
    {
      kind: 'finding',
      issue: "Aged debtor concentration: Blitz Fibre owes 3 192, 77.0% of all debtors owed on the aged debtors report, which come to 4 146, in R'000",
      quantum: 3_191_824,
      owner: 'Credit control',
      movement: 'Not tracked — no prior board pack is stored to compare against.',
      decisionRequired: BOARD_DECISIONS.agedDebtorConcentration,
    },
    ...Array.from({ length: 29 }, (_, i) => ({
      kind: 'finding' as const,
      issue: `Journal JE-2026-${String(74 + i).padStart(5, '0')} (large round-number amount): Reversal of JE-2026-${String(56 - i).padStart(5, '0')}`,
      quantum: 207_000 - i * 1_000,
      owner: 'Finance',
      movement: 'Not tracked — no prior board pack is stored to compare against.',
      decisionRequired: BOARD_DECISIONS.unusualJournal,
    })),
  ],
  // THE LIVE CLIENT'S OWN RECEIVABLES, including `reconcileSubledger`'s
  // decomposition of the gap. Read off `isaflow_dev` at 7 September 2026:
  // 4 145 971.50 of aged buckets, 4 164 721.50 of open subledger (the 18 750
  // between them being two documents with no due date), a control account at
  // (329 700), and two reconciling items that close the 4 494 421.50 between
  // subledger and control to NOTHING unexplained.
  receivables: {
    agedDebtorsTotal: 4_145_971.5,
    subledgerTotal: 4_164_721.5,
    controlBalance: -329_700,
    items: [
      {
        bridge: 'subledger_to_control' as const,
        type: 'document_not_linked_to_journal',
        description: 'open documents carrying no link to a journal entry',
        amount: 4_174_721.5,
        documentIds: Array.from({ length: 29 }, (unused, i) => `doc-${i}`),
        documentNumbers: [],
      },
      {
        bridge: 'subledger_to_control' as const,
        type: 'posting_with_no_document',
        description: 'postings that reference no document',
        amount: 319_700,
        documentIds: Array.from({ length: 98 }, (unused, i) => `je-${i}`),
        documentNumbers: [],
      },
    ],
    unexplained: 0,
  },
};
