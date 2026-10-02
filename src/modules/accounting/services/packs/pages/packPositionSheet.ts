/**
 * Page 7 as a function of the chart on it, and the height the measured sheet
 * chose for that chart — the construction `packIncomeSheet` and
 * `packCashSheet` use. Lifted out of `buildBoardPackPages` whole for the
 * 300-line cap: the statements below are the composer's own, unchanged and in
 * their own order, and it calls this where they stood.
 */
import { positionTitle } from '@/modules/accounting/services/packs/narrative/derivedSentences';
import type { MoneyScale } from '@/lib/format/money';
import type { PackFigureSet } from '@/modules/accounting/services/packs/figures/packFigureSet';
import { tradeBalancesFootnote } from './packTradeBalances';
import { buildPositionCompositionChart, positionCompositionChartAtHeight } from './packPageCharts';
import { anchorRow } from './packStatementTables';
import { buildPositionBlocks, type ImpossibleBalanceLine } from './packPageBlocks';
import { pageBoxMm, pageMm } from './packPageMetrics';
import { page, type UnnumberedPage } from './packFrontMatter';
import type { PackChartSpec, PackFootnote, PackTable } from './packPageModel';

export function buildPositionSheet(
  position: PackTable,
  statementNotes: PackFootnote[],
  set: PackFigureSet,
  scale: MoneyScale,
  page7Impossible: ImpossibleBalanceLine[],
): UnnumberedPage {
  // PAGE 7'S MEMORANDUM MARKS THE TWO ROWS ITS BALANCES SIT INSIDE. Trade
  // receivables and trade payables are not rows of this table — they are the
  // splits a reader has to be given because the day counts on pages 3 and 9
  // are taken on them — so the marker goes on Current assets and Current
  // liabilities, which is where those balances are. It is the one numbered
  // footnote whose subject is a figure the sheet does not print, and marking
  // the rows that contain it is the closest thing to an anchor that is true.
  const positionTable = anchorRow(
    anchorRow(position, (row) => row.label.toLowerCase() === 'current assets',
      statementNotes.length + 1),
    (row) => row.label.toLowerCase() === 'current liabilities', statementNotes.length + 1,
  );
  // PAGE 7, AS A FUNCTION OF THE CHART ON IT — the construction page 6 uses
  // for its bridge. It carries the two balances the day counts are taken on
  // as a footnote — see `packTradeBalances.ts` for why it is a footnote
  // rather than two memorandum rows, and what that cost.
  const positionSheet = (chart: PackChartSpec): UnnumberedPage => page(
    positionTitle(set, scale), 'Balance sheet', 'Financials', 'high',
    buildPositionBlocks(positionTable, chart, set, scale, page7Impossible),
    'portrait',
    [...statementNotes, tradeBalancesFootnote(set, scale, statementNotes.length + 1)],
  );
  // AND THE CHART GIVES BACK WHAT THE SHEET IS SHORT BY, MEASURED. The table
  // gained its closing "Total equity and liabilities" row, and on a company
  // carrying both the below-zero block and the negative-equity disclosure the
  // sheet had under two millimetres to give it: `fitPageToBox` paid for the
  // row out of the page's three footnotes, the trade-balances memorandum
  // among them. The chart is the one thing here with a height the spec lets
  // us choose, so it takes the overrun and no more — a sheet that fits keeps
  // the middle rung, and one the shorter chart cannot rescue is left to the
  // fitter as before.
  const positionChart = buildPositionCompositionChart(set, scale);
  let positionPage = positionSheet(positionChart);
  const positionOverrun = pageMm(positionPage) - pageBoxMm(positionPage);
  if (positionOverrun > 0) {
    const shorter = positionCompositionChartAtHeight(set, scale, positionChart.heightMm - positionOverrun);
    const shorterPage = shorter === null ? null : positionSheet(shorter);
    if (shorterPage !== null && pageMm(shorterPage) <= pageBoxMm(shorterPage)) {
      positionPage = shorterPage;
    }
  }
  return positionPage;
}
