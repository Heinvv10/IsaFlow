/**
 * THE LIVE ISAFLOW DEMO COMPANY, as `evidence/v2/board-demo.pdf` printed it.
 *
 * `denseInput` was built from the FIRST rendered proof and made the suite
 * green at twelve sheets. The second proof, against the same live company,
 * printed FOURTEEN — so the harness was certifying a page count the document
 * did not have, which is worse than no gate because it is believed. The two
 * things `denseInput` cannot reach:
 *
 *   1. TWENTY-EIGHT matters. `buildMatters` returns one row per unusual
 *      journal it finds, and the demo company's ledger carries twenty-six of
 *      them plus two overdue AFS filings. `denseInput` has fifteen, which fits.
 *   2. A CASH PAGE WITH FOUR FOOTNOTES. The demo company captures no
 *      operating, investing or financing cash-flow figure, so three rows of
 *      the cash table state "not captured" and the closing-cash change cell
 *      adds a fourth n/m note. `denseInput` supplies all three figures, so its
 *      cash page carries one footnote and never spills.
 *
 * Both were invisible to the harness and both are what overflowed: sheet 9 of
 * the live render carried two footnote lines and nothing else, and sheet 13
 * the tail of the matters table.
 *
 * Every figure below is read off the printed sheets of `evidence/v2/board-demo.pdf`
 * (at R'000, so they are the printed thousands multiplied back to rands),
 * because a fixture chosen for laying out well is what let this defect ship.
 */
import type { BoardPackInput } from '@/modules/accounting/services/packs/pages/boardPackPages';
import type { PackFigureSet } from '@/modules/accounting/services/packs/figures/packFigureSet';
import type { PackMatter } from '@/modules/accounting/services/packs/pages/packMatters';
import type { PackTrendPoint } from '@/modules/accounting/services/packs/packTrendService';
import { demoInput, figures } from './boardPackInputs';

const NO_PRIOR_MEETING_RECORD = 'Not tracked — no prior board pack is stored to compare against.';

/**
 * Sheet 6, 7 and 8 of the live render, in rands.
 *
 * `operatingCashFlow`, `capitalExpenditure` and `financingCashFlow` are
 * ABSENT rather than zero, which is what the demo company's ledger gives:
 * `buildCashTable` prints "No operating cash flow figure was captured for
 * this period." in each of those three rows and footnotes each one.
 */
export const liveDemoSet: PackFigureSet = {
  current: figures({
    revenue: 98_800,
    costOfSales: 1_430_581,
    operatingExpenses: 225_571,
    otherIncome: 11_812,
    otherExpenses: 0,
    operatingProfit: -1_545_540,
    netProfit: -1_545_540,
    totalAssets: -733_000,
    totalLiabilities: 3_355_000,
    totalEquity: -4_088_000,
    currentAssets: -467_000,
    currentLiabilities: 3_355_000,
    cash: -532_332,
    accountsReceivable: 620_400,
    accountsPayable: 3_120_800,
    inventory: 0,
    operatingCashFlow: undefined,
    capitalExpenditure: undefined,
    financingCashFlow: undefined,
  }),
  currentWindow: { start: '2026-01-01', end: '2026-09-07' },
  // Revenue of zero is not a positive base, so every change cell on every
  // statement holds a sentence instead of a percentage — the density that
  // doubled the height of pages 5 to 8 on the first proof.
  prior: figures({
    revenue: 0,
    costOfSales: 805_000,
    operatingExpenses: 112_000,
    otherIncome: 12_000,
    otherExpenses: 0,
    operatingProfit: -905_000,
    netProfit: -905_000,
    totalAssets: -262_000,
    totalLiabilities: 2_281_000,
    totalEquity: -2_543_000,
    currentAssets: -125_000,
    currentLiabilities: 2_281_000,
    cash: -124_856,
    accountsReceivable: 410_000,
    accountsPayable: 2_240_000,
    inventory: 0,
    operatingCashFlow: undefined,
    capitalExpenditure: undefined,
    financingCashFlow: undefined,
  }),
  priorWindow: { start: '2025-04-26', end: '2025-12-31' },
  budget: null,
};

/**
 * Twelve month-end positions ending at the pack's own period end.
 *
 * The last point IS the period end, not the end of the calendar month
 * containing it — see `monthSlots`. A series whose final month-end runs past
 * the reporting date states a second, different closing cash on the same
 * sheet as the cash table, which is what sheet 8 of the live render did:
 * `(532)` in the table and `(752)` in the line chart's own title.
 */
export const liveDemoTrend: PackTrendPoint[] = Array.from({ length: 12 }, (_, i) => {
  const monthIndex = (9 + i) % 12; // Oct 2025 .. Sep 2026
  const year = i < 3 ? 2025 : 2026;
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  // A shallow decline to a trough and back, ending on the pack's own closing
  // cash — the shape sheet 8's sparkline draws.
  const cashPath = [
    -115_000, -118_000, -240_000, -300_000, -372_000, -455_000,
    -520_000, -610_000, -690_000, -430_000, -470_000, -532_332,
  ];
  return {
    month: `${year}-${String(monthIndex + 1).padStart(2, '0')}`,
    label: `${names[monthIndex]} ${year}`,
    revenue: 0,
    expenses: 120_000 + i * 4_000,
    netProfit: -120_000 - i * 4_000,
    costOfSales: 96_000 + i * 3_000,
    operatingExpenses: 24_000 + i * 1_000,
    grossMarginPct: null,
    cash: cashPath[i]!,
    accountsReceivable: 480_000 + i * 12_000,
    debtorDays: null,
  };
});

/**
 * Twenty-eight matters, worded as `buildMatters` words them.
 *
 * Twenty-six unusual journals ranked by quantum — the tail of them worth a
 * few hundred rand, which is the case that printed a quantum of `0` under an
 * `R'000` header — and two overdue AFS filings with no single amount at all.
 */
export const liveDemoMatters: PackMatter[] = [
  ...Array.from({ length: 26 }, (_, i) => ({
    // `kind` IS REQUIRED ON `PackMatter` AND THIS FIXTURE OMITTED IT — tests
    // are outside `tsconfig`'s `include`, so nothing said so. `mattersTitle`
    // counts `kind === 'finding'`, so the fixture named after the live pack
    // composed a page 11 headed "0 matters require a board decision this
    // period" where the live pack prints "28 matters require a board decision,
    // 26 of them carrying 1 675 R'000 of exposure" — and the amount check in
    // `checkMattersAmounts` had nothing to check.
    kind: 'finding' as const,
    issue: `Journal JE-2026-${String(15 - (i % 15)).padStart(5, '0')} (recorded well after its entry date): ${
      ['Interest Income', 'Bank Charges', 'repro after fix', 'repro'][i % 4]
    } - 2026/${String((i % 9) + 1).padStart(2, '0')}`,
    // 244 800 down to 400: the last few round to nothing at R'000.
    quantum: Math.max(400, 244_800 - i * 9_600),
    owner: 'Finance',
    movement: NO_PRIOR_MEETING_RECORD,
    decisionRequired: 'Confirm supporting evidence for this entry or refer it for reversal.',
  })),
  ...[2024, 2026].map((fy) => ({
    kind: 'finding' as const,
    issue: `Annual Financial Statements for FY${fy} is ${fy === 2024 ? 739 : 10} day(s) overdue (due ${fy === 2024 ? '2024-08-28' : '2026-08-27'})`,
    quantum: null,
    owner: 'Company secretary',
    movement: NO_PRIOR_MEETING_RECORD,
    decisionRequired: 'Approve immediate filing and confirm any penalty exposure.',
  })),
];

export const liveDemoInput: BoardPackInput = {
  ...demoInput,
  period: '1 January 2026 to 7 September 2026',
  draftReasons: ['openPeriod', 'unapprovedCommentary'],
  set: liveDemoSet,
  trend: liveDemoTrend,
  matters: liveDemoMatters,
  // Nothing in this codebase stores board commentary, so both narrative pages
  // printed the pending placeholder — as they did on the live render.
  commentary: null,
  mattersCommentary: null,
};

/**
 * THE TWO SHAPES THAT PRINTED FOURTEEN AND THIRTEEN SHEETS.
 *
 * `MATTERS_PRINTED_MAX` seeded its keep-set with EVERY null-quantum matter
 * before it consulted the cap, so a company whose matters are mostly filings
 * printed all of them. A reviewer reproduced both through the print harness at
 * the commit that claimed the twelve-sheet contract: twenty long null-quantum
 * matters at fourteen sheets, twenty-six short ones at thirteen.
 *
 * Both are reachable — `getOverdueStatutoryFilings` emits one matter per
 * unfiled `afs_documents` row with no `LIMIT` and no `DISTINCT` on fiscal
 * year — and neither could fail a build, because nothing in the live route
 * counts sheets. They are here as the fixtures the line budget is measured
 * against, LONG and SHORT, because a row's cost is its text and a row count
 * cannot tell the two apart.
 *
 * The long wording is `buildMatters`' own `failedSourceMatter`, which embeds
 * `String(error)`; the short one is the overdue-filing wording above.
 */
const nullQuantumMatter = (issue: string): PackMatter => ({
  issue,
  quantum: null,
  owner: 'Finance',
  movement: NO_PRIOR_MEETING_RECORD,
  decisionRequired: 'Approve immediate filing and confirm any penalty exposure.',
});

export const manyLongNullQuantumMattersInput: BoardPackInput = {
  ...liveDemoInput,
  matters: Array.from({ length: 20 }, (_, i) =>
    nullQuantumMatter(
      `The aged debtor concentration check could not be run, so this pack does not state it: `
      + `Error: connection to the reporting replica was reset while reading company `
      + `d27bac33-0000-0000-0000-00000000${String(i).padStart(4, '0')}`,
    )),
};

export const manyShortNullQuantumMattersInput: BoardPackInput = {
  ...liveDemoInput,
  matters: Array.from({ length: 26 }, (_, i) =>
    nullQuantumMatter(`Annual Financial Statements for FY${2000 + i} is ${100 + i} day(s) overdue`)),
};

/**
 * The same pack with a cash series that runs one calendar month PAST the
 * reporting date, which is what `monthSlots` used to return.
 *
 * Kept because it is the only fixture that reproduces the two-closing-cash
 * contradiction, and the integrity gate has to refuse it.
 */
export const liveDemoTrailingMonthInput: BoardPackInput = {
  ...liveDemoInput,
  trend: liveDemoTrend.map((point, i) =>
    i === liveDemoTrend.length - 1 ? { ...point, cash: -752_000 } : point),
};
