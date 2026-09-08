/**
 * PAGE 6 — THE INCOME STATEMENT, AND THE BRIDGE WHOSE HEIGHT THE SHEET
 * DECIDES.
 *
 * Lifted out of `boardPackPages` whole. The composer had grown to 995 lines
 * around a single 450-line function, and this is the largest self-contained
 * piece of it: everything page 6 is, plus the measure-compose-remeasure loop
 * that chooses the bridge's rung. Nothing changed in the move — the inputs
 * the closure read off the composer's scope are arguments now, and the two
 * loops below are the same two loops.
 */
import type { PackFigureSet } from '@/modules/accounting/services/packs/figures/packFigureSet';
import { disproportionatePlugSentence } from '@/modules/accounting/services/packs/figures/packWaterfallIntegrity';
import { impossibleIncomeLinesSentence, incomeStatementTitle, largestMoverCaption } from '@/modules/accounting/services/packs/narrative/derivedSentences';
import { buildProfitWaterfallChart, profitBridgeAtHeight, shorterProfitBridge } from './packPageCharts';
import { anchorRow } from './packStatementTables';
import { bridgeSignFootnote, commentary, mustDisclose, note } from './packPageBlocks';
import { page, type UnnumberedPage } from './packFrontMatter';
import { pageBoxMm, pageMm } from './packPageMetrics';
import { periodWindowFootnotes } from './packTrendCrossReference';
import type { MoneyScale } from '@/lib/format/money';
import type {
  PackChartSpec,
  PackFootnote,
  PackPageBlock,
  PackTable,
} from './packPageModel';

/**
 * WHICH SIDE OF THE INCOME STATEMENT EACH LINE IS, BY ROW KEY.
 *
 * Keyed on `PackTableRow.key` rather than on the label, because the label is
 * prose a later round can reword and the key is the row's identity — and a
 * classification driven by a regex over labels is one rename away from
 * putting operating profit in the cost band. A row absent from this map is a
 * SUBTOTAL, and subtotals are deliberately outside the check: a negative
 * gross, operating or net profit is a real result.
 */
const INCOME_LINE_SIDE: Record<string, 'income' | 'cost' | undefined> = {
  'is.revenue': 'income',
  'is.otherIncome': 'income',
  'is.costOfSales': 'cost',
  'is.operatingExpenses': 'cost',
  'is.otherExpenses': 'cost',
};

/** Page 6, its bridge, and the rung the measured page chose for it. */
export function buildIncomeStatementSheet(
  income: PackTable,
  set: PackFigureSet,
  scale: MoneyScale,
  panels: PackChartSpec[],
  statementNotes: PackFootnote[],
): UnnumberedPage {
// The profit bridge reaches net profit through a step nothing measured —
// interest and tax, which no field carries. Where that step is a material
// share of the figure the bridge lands on, the page must say so, and the
// integrity gate refuses a pack that draws it silently.
// THE SIGN CHECK, OVER EVERY INCOME AND COST LINE THIS PAGE PRINTS —
// `impossibleIncomeLinesSentence`, and the same shape as page 7's. It ran
// on REVENUE alone, so Brightsphere's sheet 6 headed a block about revenue
// of (5 535) and printed operating expenses of (3 717), other expenses of
// (411) and other income of (1) under it without a word. Read off the
// table the page prints, by KEY rather than by label, so it can only name a
// row the sheet shows.
//
// Subtotals are excluded on purpose: gross profit, operating profit and net
// profit below zero are real results, and are the income statement's
// equivalent of the negative equity page 7 keeps out of its own check.
const impossibleIncome = income.rows
  .map((row) => ({ row, side: INCOME_LINE_SIDE[row.key ?? ''] }))
  .filter((entry) => entry.side !== undefined)
  .map((entry) => ({
    label: entry.row.label,
    amount: entry.row.figures.actual?.value ?? 0,
    side: entry.side!,
  }))
  .filter((line) => line.amount < 0);
const negativeRevenueCaveat: PackPageBlock[] = impossibleIncome.length === 0
  ? []
  : [mustDisclose('Lines below zero', [
      note('What this means', impossibleIncomeLinesSentence(
        impossibleIncome,
        impossibleIncome.every((l) => l.side === 'income')
          ? 'income'
          : (impossibleIncome.every((l) => l.side === 'cost') ? 'cost' : 'both'),
        scale,
        impossibleIncome.some((l) => l.label.toLowerCase() === 'revenue'),
      )),
    ])];

// The bridge steps down a rung where this page also carries the trends
// cross-reference footnote — see `buildProfitWaterfallChart`. Derived from
// the same call that puts the footnote on the page below, so the height and
// the footnote cannot disagree about whether the panel exists.
const grossMarginWindowNote = periodWindowFootnotes(panels, 'trend-gross-margin', 'Income statement', 1);

// PAGE 6, AS A FUNCTION OF THE BRIDGE ON IT, because the height of the
// bridge is decided by measuring this page rather than by predicting it —
// see `shorterProfitBridge` and the loop below. Everything here except the
// chart is the same at every rung; the plug sentence and the sign footnote
// are rebuilt from the bridge passed in rather than from a bridge built
// once, so a page cannot describe a chart it is not carrying.
const incomeStatementSheet = (bridge: PackChartSpec): UnnumberedPage => {
  const profitPlug = disproportionatePlugSentence(bridge, scale);
  const profitBridgeCaveat: PackPageBlock[] = profitPlug === null
    ? []
    : [mustDisclose('How much of this bridge is unexplained', [note('Size of the unexplained step', profitPlug)])];
  // The bridge labels a cost line the opposite way the table does, and both
  // are right — see `bridgeSignFootnote`. Printed only where a line actually
  // diverges, and it names that line, so the next footnote's number depends
  // on whether this one is there.
  const bridgeNote = bridgeSignFootnote(income, bridge, scale, statementNotes.length + 1);
  // AND THE BRIDGE NOTE MARKS THE LINE IT WALKS THROUGH. It names one row —
  // Cost of sales on the demo, Operating expenses on Brightsphere — and a
  // reader looking at that row had nothing telling them the sentence at the
  // page foot was about it.
  const marginNumber = statementNotes.length + bridgeNote.footnotes.length + 1;
  const marginNote = periodWindowFootnotes(
    panels, 'trend-gross-margin', 'Income statement', marginNumber,
  );
  let incomeTable = income;
  if (bridgeNote.anchor !== null) {
    const anchor = bridgeNote.anchor.toLowerCase();
    incomeTable = anchorRow(incomeTable,
      (row) => row.label.toLowerCase() === anchor, statementNotes.length + 1);
  }
  // The gross-margin cross-reference is about gross margin, and Gross
  // profit is the row it is computed from — the only row on this sheet the
  // sentence could be marking.
  if (marginNote.length > 0) {
    incomeTable = anchorRow(incomeTable,
      (row) => row.label.toLowerCase() === 'gross profit', marginNumber);
  }
  return page(incomeStatementTitle(set, scale), 'Income statement', 'Financials', 'high', [
    { kind: 'table', table: incomeTable },
    { kind: 'chart', chart: bridge },
    commentary(largestMoverCaption(income.rows, scale)),
    // The same treatment page 7 gives negative assets. Brightsphere heads
    // this page with revenue of (5 535) and said nothing about it, two
    // sheets before explaining a negative asset side at length.
    ...negativeRevenueCaveat,
    ...profitBridgeCaveat,
    // The reciprocal of the trends page's own window note rides in this
    // page's FOOTNOTES, below — see `periodWindowFootnotes`.
  ], 'portrait', [
    ...statementNotes,
    ...bridgeNote.footnotes,
    ...marginNote,
  ]);
};

// AND THE RUNG IS CHOSEN BY MEASURING THE PAGE, NOT BY PREDICTING IT.
//
// Live Brightsphere carries the negative-revenue disclosure, a required
// sign-flip footnote and a three-line caption saying no percentage change
// is meaningful, and at the rung the predicates chose the sheet measured
// 260.5mm in a 255mm box with nothing left on it `fitPageToBox` may drop —
// so the company could not be given a board pack at all. Nothing on the
// page is spare: every block carries a figure or a note the pack owes the
// reader, and the chart is the one thing on it with a height the spec lets
// us choose.
//
// A page that already fits is composed once and keeps the height it has.
let profitBridge = buildProfitWaterfallChart(set, scale, grossMarginWindowNote.length > 0);
let incomeSheet = incomeStatementSheet(profitBridge);
while (pageMm(incomeSheet) > pageBoxMm(incomeSheet)) {
  const shorter = shorterProfitBridge(set, scale, profitBridge);
  if (shorter === null) break;
  profitBridge = shorter;
  incomeSheet = incomeStatementSheet(profitBridge);
}
// AND THEN BACK INTO WHATEVER THE PAGE ACTUALLY HAS. The ladder steps 24
// and 38mm at a time and the decision it answers is measured in tenths:
// live Brightsphere missed the 72mm rung by 0.2mm and printed a 48mm
// bridge with 23.8mm of white under it, against the demo's 72. The ladder
// chooses the rung; the paper decides the last few millimetres. Verified
// by re-measuring rather than by arithmetic — the taller chart is the only
// thing that moves, but a page proves it fits by being measured.
const spare = pageBoxMm(incomeSheet) - pageMm(incomeSheet);
if (spare > 1) {
  const grown = profitBridgeAtHeight(
    set, scale, grossMarginWindowNote.length > 0, profitBridge.heightMm + spare - 0.5,
  );
  if (grown !== null && grown.heightMm > profitBridge.heightMm) {
    const grownSheet = incomeStatementSheet(grown);
    if (pageMm(grownSheet) <= pageBoxMm(grownSheet)) {
      profitBridge = grown;
      incomeSheet = grownSheet;
    }
  }
}
  return incomeSheet;
}
