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
    // THE SECOND CAVEAT, WHICH IS WHY PAGE 12 WAS NEVER TESTED AT ITS REAL
    // HEIGHT. The live demo company has no account classified as inventory,
    // so `buildPackFigureSet` returns this caveat on every render; the pack
    // then prints TWO caveats — this and the draft sentence the two
    // `draftReasons` below produce — where this fixture printed one. Page 12
    // is the tightest prose page in the pack and a caveat is five lines of
    // it, so the fixture was six centimetres short of the page it claimed to
    // model, and no test in the suite could see the basis of preparation
    // losing five of its eight facts on the live company. Copied verbatim
    // from `isaflow_dev` on 2026-09-07.
    inventoryCaveat: 'No account in the chart of accounts is classified as inventory, so inventory '
      + 'could not be identified and the quick ratio does not exclude it: on these figures the '
      + 'quick ratio and the current ratio are the same number. Read it as a current ratio until '
      + 'the stock control account is classified.',
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
  // AND THE LAST MONTH IS THE STUB THE PACK IS RUN OVER.
  //
  // The reporting date is 7 September 2026, so the twelfth point covers seven
  // of September's thirty days — and this fixture carried none of the three
  // fields that say so, leaving `partial` undefined. Every "(part)" marker in
  // the pack, on sheet 5's rows, both of sheet 8's axes, six panel captions
  // on sheet 10, sheet 12's Period fact and sheet 3's reading note, was
  // therefore absent from the fixture that claims to BE the live render — so
  // no test in the suite could measure a page carrying them, which is how a
  // note added to sheet 3 could push live Brightsphere's sheet 3 over its box
  // with the whole suite green.
  const daysInMonth = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][monthIndex]!;
  const partial = i === 11;
  return {
    month: `${year}-${String(monthIndex + 1).padStart(2, '0')}`,
    label: `${names[monthIndex]} ${year}`,
    partial,
    daysCovered: partial ? 7 : daysInMonth,
    daysInMonth,
    revenue: 0,
    otherIncome: 0,
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
 * THE SAME TWELVE MONTHS AS THE RENDERED PACK, WITH THE FOUR SERIES
 * `liveDemoTrend` LEAVES NULL.
 *
 * `liveDemoTrend` carries zero revenue in every month, so gross margin and
 * debtor days are not meaningful and the trends sheet draws FOUR panels. The
 * rendered pack draws SIX — the live company's revenue is small, not absent —
 * and six panels are what put that sheet past its box and made it drop both
 * of the notes its own percentage claims are checked against. No fixture
 * could see that, because no fixture reached six panels on a page that also
 * carries prose.
 *
 * The endpoints are the rendered sheet's own, read off the render: revenue
 * 2 to 29, gross margin (4267.6%) to 100.0%, operating expenses 15 to 41, net
 * profit (99) to (12) with Jul 2026 alone at 1 908, cash (115) to (531),
 * debtor days 0.0 to 60.5 — a shared money domain of (1 621) to 1 908 R'000.
 */
export const liveDemoRenderedTrend: PackTrendPoint[] = liveDemoTrend.map((point, i) => {
  // Revenue climbs from 2 to 29 R'000, flat until the last quarter.
  const revenue = i < 9 ? 2_000 + i * 400 : 5_600 + (i - 8) * 7_800;
  // One month whose expenses were a net credit — the +1 908 spike the sheet
  // names — and one at the bottom of the shared domain.
  const netProfit = i === 9 ? 1_908_000 : (i === 6 ? -1_621_000 : -99_000 + i * 7_000);
  return {
    ...point,
    revenue,
    // Jul 2026's expenses are a NET CREDIT — R1 869 169.85 reversed out of
    // expense accounts — which is what puts the credit-month matter on sheets
    // 4 and 11 and the +1 908 spike on sheet 10. The two differ by the
    // month's revenue, and `packDerivedMatters` asserts that identity.
    expenses: i === 9 ? -1_869_169.85 : point.expenses,
    operatingExpenses: 15_000 + i * 2_364,
    netProfit,
    grossMarginPct: i === 0 ? -4_267.6 : -4_267.6 + ((i / 11) * 4_367.6),
    debtorDays: i < 9 ? 0 : (i - 8) * 20.166,
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

/** The live demo company as it actually renders: six trend panels, not four.
 *  See `liveDemoRenderedTrend`. */
export const liveDemoRenderedInput: BoardPackInput = {
  ...liveDemoInput,
  trend: liveDemoRenderedTrend,
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

/**
 * THE SHAPE THAT MADE THE COMPOSER'S RULER READ SHORT — cash in the millions.
 *
 * `packPageMetrics` is only worth anything while it never under-estimates: a
 * model that reads a page 3mm shorter than the browser lays it out passes a
 * page that then takes a thirteenth sheet, which is the failure the model
 * replaced. On the live Brightsphere ledger it does exactly that on sheet 8 —
 * 195.6mm against 198.8mm on the paper — and no fixture could see it, because
 * every one of them has cash in the hundreds of thousands.
 *
 * The block is the "Movement in cash, and why no bridge is drawn" disclosure,
 * whose sentence quotes three cash figures. At Brightsphere's scale each of
 * them formats with a thousands separator — "(3 453)" where the demo company
 * prints "(531)" — which is four more characters across the paragraph, and
 * four is enough: Chromium sets the sentence in FIVE lines at 426 characters
 * and four at 422, while the model answers four at both. Measured, the model
 * is 0.29% too generous on that string, which is a hair either side of a line
 * break rather than a mis-weighted glyph.
 *
 * So the fixture is the live demo company with Brightsphere's cash: the only
 * fields that change are the ones that lengthen the figures in that sentence.
 */
export const millionsCashInput: BoardPackInput = {
  ...liveDemoInput,
  set: {
    ...liveDemoSet,
    current: { ...liveDemoSet.current, cash: -3_453_000 },
    prior: liveDemoSet.prior === null ? null : { ...liveDemoSet.prior, cash: -267_000 },
  },
  // The series ends on the pack's own closing cash or `assertPackIntegrity`
  // refuses the render — page 8 may not state one quantity at two values. So
  // the trend moves with the figure set rather than beside it.
  trend: liveDemoTrend.map((point, i) => (i === liveDemoTrend.length - 1
    ? { ...point, cash: -3_453_000 }
    : point)),
};

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

/**
 * THE LIVE DEMO COMPANY'S OWN OPERATING PROFIT AND DEPRECIATION — the two
 * figures that put the EBITDA reconciliation note on page 12.
 *
 * `liveDemoSet` above rounds operating profit to (1 545 540) and takes the
 * shared fixture's 96 000 of depreciation, and on those two numbers the
 * three-line EBITDA bridge adds up as printed, so `bridgeRoundingNote`
 * returns undefined and page 12 measures 248.3mm. The ledger's own figures
 * are (1 544 539.88) and 77 203.04: rounded to R'000 they print (1 545) plus
 * 77 = (1 467) where the printed operands give (1 468), the note fires, and
 * the glossary grows by 7.4mm — which takes the basis page to 255.7mm in a
 * 255mm box and costs FOUR of its eight provenance facts to `fitPageToBox`.
 *
 * A unit in the second decimal of one figure, and no fixture in the suite
 * could see it.
 */
export const liveDemoBridgeSet: PackFigureSet = {
  ...liveDemoSet,
  current: {
    ...liveDemoSet.current,
    operatingProfit: -1_544_539.88,
    netProfit: -1_544_539.88,
    depreciation: 77_203.04,
  },
};

export const liveDemoBridgeInput: BoardPackInput = {
  ...liveDemoRenderedInput,
  set: liveDemoBridgeSet,
};
