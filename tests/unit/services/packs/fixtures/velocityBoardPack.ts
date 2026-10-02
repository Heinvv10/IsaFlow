/**
 * VELOCITY FIBRE'S PRODUCTION BOARD PACK, 1 JANUARY TO 2 OCTOBER 2026.
 *
 * Read off the PDF a director downloaded on 2 October 2026 — the pack that
 * printed 19 588 "matters", "Revenue is down 100.0%", a cash ratio of "–" and
 * a prior debtor days of "(30 days)". Every figure here is that render's, in
 * rand (the pack prints R'000), so a fix is proved against the document that
 * failed rather than against a fixture that happens to lay out well.
 *
 * The shape the other fixtures lack, all at once:
 *   - the series ends on a part month of TWO days (Oct 2026, 2 of 31), with
 *     no revenue posted in it — the stub that set page 10's headline;
 *   - cash is tiny against current liabilities (277 over 80 584), so the cash
 *     ratio is a real figure below two places;
 *   - the comparative carries receivables in net credit and an operating loss;
 *   - equity is negative in both periods;
 *   - the ledger was reloaded in bulk, so almost every journal in the window
 *     was recorded weeks after its date.
 *
 * Revenue, cost of sales and the operating band per month are page 5's rows;
 * cash per month is page 8's line.
 */
import type { BoardPackInput } from '@/modules/accounting/services/packs/pages/boardPackPages';
import type { PackFigureSet } from '@/modules/accounting/services/packs/figures/packFigureSet';
import type { PackMatter } from '@/modules/accounting/services/packs/pages/packMatters';
import type { PackTrendPoint } from '@/modules/accounting/services/packs/packTrendService';
import { BOARD_DECISIONS } from '@/modules/accounting/services/packs/pages/packMatterDecisions';
import { demoInput, figures } from './boardPackInputs';

const NO_PRIOR_MEETING_RECORD = 'Not tracked — no prior board pack is stored to compare against.';

const NO_INVENTORY = 'No account in the chart of accounts is classified as inventory, so inventory '
  + 'could not be identified and the quick ratio does not exclude it: on these figures the '
  + 'quick ratio and the current ratio are the same number. Read it as a current ratio until '
  + 'the stock control account is classified.';

export const velocitySet: PackFigureSet = {
  current: figures({
    companyName: 'Velocity Fibre (Pty) Ltd',
    period: '2026-01-01 to 2026-10-02',
    revenue: 95_526_000,
    costOfSales: 69_967_000,
    operatingExpenses: 21_698_000,
    otherIncome: 0,
    otherExpenses: 50_000,
    operatingProfit: 3_861_000,
    netProfit: 3_811_000,
    totalAssets: 33_416_000,
    totalLiabilities: 81_839_000,
    totalEquity: -48_423_000,
    currentAssets: 31_838_000,
    currentLiabilities: 80_584_000,
    cash: 277_000,
    accountsReceivable: 16_089_000,
    accountsPayable: 17_937_000,
    inventory: 0,
    operatingCashFlow: -1_492_000,
    capitalExpenditure: 17_000,
    financingCashFlow: 1_243_000,
    depreciation: 181_000,
    interestExpense: 49_838,
    interestIncome: 0,
    taxExpense: 0,
    employeeCosts: 0,
    employeeCount: 0,
    inventoryCaveat: NO_INVENTORY,
  }),
  currentWindow: { start: '2026-01-01', end: '2026-10-02' },
  prior: figures({
    companyName: 'Velocity Fibre (Pty) Ltd',
    period: '2025-04-01 to 2025-12-31',
    revenue: 13_163_000,
    costOfSales: 51_512_000,
    operatingExpenses: 13_820_000,
    otherIncome: 0,
    otherExpenses: 65_000,
    operatingProfit: -52_169_000,
    netProfit: -52_234_000,
    totalAssets: 6_901_000,
    totalLiabilities: 59_135_000,
    totalEquity: -52_234_000,
    currentAssets: 6_722_000,
    currentLiabilities: 59_135_000,
    cash: 544_000,
    accountsReceivable: -1_097_000,
    accountsPayable: 9_423_000,
    inventory: 0,
    operatingCashFlow: 723_000,
    capitalExpenditure: 179_000,
    financingCashFlow: 0,
    depreciation: 0,
    interestExpense: 64_783,
    interestIncome: 0,
    taxExpense: 0,
    employeeCosts: 0,
    employeeCount: 0,
    inventoryCaveat: NO_INVENTORY,
  }),
  priorWindow: { start: '2025-04-01', end: '2025-12-31' },
  budget: null,
};

/** Page 5's rows and page 8's line, Nov 2025 to Oct 2026 (part), in R'000. */
const MONTHS: Array<[string, string, number, number, number, number, number, number | null]> = [
  // month, label, revenue, cost of sales, operating, other, cash, debtor days
  ['2025-11', 'Nov 2025', 2_932, 4_693, 1_764, 0, 614, 0],
  ['2025-12', 'Dec 2025', 3_397, 6_370, 1_631, 65, 552, -10],
  ['2026-01', 'Jan 2026', 9_661, 5_092, 1_895, 17, 4_310, 5],
  ['2026-02', 'Feb 2026', 8_673, 10_694, -1_350, 0, 478, 15],
  ['2026-03', 'Mar 2026', 9_966, 5_843, 3_332, 32, 620, 20],
  ['2026-04', 'Apr 2026', 5_663, 4_840, 2_179, 0, 1_152, 25],
  ['2026-05', 'May 2026', 3_993, 9_440, 2_157, 0, 403, 41],
  ['2026-06', 'Jun 2026', 9_730, 6_376, 2_591, 0, 198, 28],
  ['2026-07', 'Jul 2026', 15_283, 7_995, 4_700, 0, 1_196, 18],
  ['2026-08', 'Aug 2026', 9_181, 9_582, 4_524, 0, 392, 24],
  ['2026-09', 'Sep 2026', 23_377, 10_105, 1_668, 0, 289, 21],
  ['2026-10', 'Oct 2026', 0, 0, 1, 0, 277, null],
];

const DAYS_IN = [30, 31, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31];

export const velocityTrend: PackTrendPoint[] = MONTHS.map(
  ([month, label, revenue, costOfSales, operating, other, cash, debtorDays], i) => {
    const partial = i === MONTHS.length - 1;
    const k = (n: number): number => n * 1_000;
    return {
      month,
      label,
      partial,
      daysCovered: partial ? 2 : DAYS_IN[i]!,
      daysInMonth: DAYS_IN[i]!,
      revenue: k(revenue),
      otherIncome: 0,
      expenses: k(costOfSales + operating + other),
      netProfit: k(revenue - costOfSales - operating - other),
      costOfSales: k(costOfSales),
      operatingExpenses: k(operating),
      grossMarginPct: revenue === 0 ? null : ((revenue - costOfSales) / revenue) * 100,
      cash: k(cash),
      accountsReceivable: debtorDays === null ? 16_089_000 : k(Math.round((revenue * debtorDays) / DAYS_IN[i]!)),
      debtorDays,
    };
  },
);

/** The round-number journals the pack still raises once a bulk reload is no
 *  longer read as backdating, worded as `buildMatters` words them. */
const ROUND_NUMBER_JOURNALS: Array<[string, string, number]> = [
  ['JE-2026-02498', 'loan-fibertime', 6_000_000],
  ['JE-2026-16459', 'Customer invoice INV0000419', 6_000_000],
  ['JE-2026-16460', 'Customer payment CP-2026-00067', 6_000_000],
  ['JE-2026-01693', 'loan-fibertime', 6_000_000],
  ['JE-2026-01835', 'transfer', 4_500_000],
  ['JE-2026-03310', 'loan-fibertime', 3_000_000],
  ['JE-2026-07702', 'transfer', 2_000_000],
  ['JE-2026-11204', 'Customer payment CP-2026-00031', 1_500_000],
  ['JE-2026-12876', 'transfer', 1_000_000],
];

export const velocityMatters: PackMatter[] = [
  {
    kind: 'finding',
    issue: '30 unreconciled bank items across 2 bank accounts, as at the time this pack was extracted '
      + 'rather than at the period end; receipts and payments among them net to nil on each account, '
      + 'so no amount is stated',
    quantum: null,
    owner: 'Bookkeeping',
    movement: NO_PRIOR_MEETING_RECORD,
    decisionRequired: BOARD_DECISIONS.unreconciledBank,
  },
  {
    kind: 'finding',
    issue: 'Aged debtor concentration: Herotel owes 10 353, 64.3% of all debtors owed on the aged '
      + 'debtors report, which come to 16 089, in R\'000.',
    quantum: 10_353_000,
    owner: 'Credit control',
    movement: NO_PRIOR_MEETING_RECORD,
    decisionRequired: BOARD_DECISIONS.agedDebtorConcentration,
  },
  ...ROUND_NUMBER_JOURNALS.map(([entry, description, amount]) => ({
    kind: 'finding' as const,
    issue: `Journal ${entry} (large round-number amount): ${description}`,
    quantum: amount,
    owner: 'Finance',
    movement: NO_PRIOR_MEETING_RECORD,
    decisionRequired: BOARD_DECISIONS.unusualJournal,
  })),
];

export const velocityInput: BoardPackInput = {
  ...demoInput,
  companyLegalName: 'Velocity Fibre (Pty) Ltd',
  period: '1 January 2026 to 2 October 2026',
  generatedAt: '2026-10-02T11:27:00.000Z',
  draftReasons: ['openPeriod', 'unapprovedCommentary'],
  set: velocitySet,
  trend: velocityTrend,
  matters: velocityMatters,
  // The September 2026 reload, at the scale page 11 printed (19 581 matters
  // "not printed"). The count is that page's, not a census of the ledger; the
  // span is the reload's recording days on the production copy of 18
  // September 2026 (5 to 18 September, twelve days).
  bulkLoadedJournals: { journals: 19_581, days: 12, firstRecorded: '2026-09-05', lastRecorded: '2026-09-18' },
  receivables: {
    agedDebtorsTotal: 16_089_000,
    subledgerTotal: 16_089_000,
    controlBalance: velocitySet.current.accountsReceivable,
    items: [],
    unexplained: 0,
  },
  commentary: null,
  mattersCommentary: null,
  ledgerVersion: '2026-10-02T09:32:00.000Z',
};
