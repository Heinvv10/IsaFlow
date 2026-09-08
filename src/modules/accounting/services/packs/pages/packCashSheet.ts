/**
 * PAGE 8 — CASH, AND THE HEIGHT ITS OWN SHEET CHOSE FOR THE TREND LINE.
 *
 * Lifted out of `boardPackPages` whole, the same construction and for the same
 * reason as `packIncomeSheet`: the height of the one chart the spec lets us
 * choose is decided by MEASURING the composed sheet, not by a constant picked
 * against one company's data. Nothing changed in the move.
 */
import type { PackFigureSet } from '@/modules/accounting/services/packs/figures/packFigureSet';
import type { PackTrendPoint } from '@/modules/accounting/services/packs/packTrendService';
import { cashTitle } from '@/modules/accounting/services/packs/narrative/derivedSentences';
import { shorterCashTrendChart } from './packPageCharts';
import { anchorRow } from './packStatementTables';
import { buildCashBlocks } from './packPageBlocks';
import type { PackCashBridge } from './packPageCharts';
import { page, type UnnumberedPage } from './packFrontMatter';
import { pageBoxMm, pageMm } from './packPageMetrics';
import { cashWindowFootnotes } from './packTrendCrossReference';
import type { MoneyScale } from '@/lib/format/money';
import type { PackChartSpec, PackFootnote, PackTable } from './packPageModel';

export function buildCashSheet(
  cash: PackTable,
  cashBridge: PackCashBridge,
  cashTrend: PackChartSpec | null,
  trend: PackTrendPoint[],
  set: PackFigureSet,
  scale: MoneyScale,
  statementNotes: PackFootnote[],
): UnnumberedPage {
// PAGE 8, AS A FUNCTION OF THE CASH LINE ON IT — the same construction
// page 6 uses for its bridge, and for the same reason: the height of the
// one chart the spec lets us choose is decided by measuring the composed
// sheet, not by a constant chosen against one company's data.
const cashSheet = (line: PackChartSpec | null): UnnumberedPage =>
  // The cash page is the one sheet carrying BOTH windows — the table's
  // period opening balance and the twelve-month line beneath it — and it
  // was the one page with no note saying so. See `cashWindowFootnotes`.
  (() => {
    const windowNotes = cashWindowFootnotes(trend, line !== null, statementNotes.length + 1);
    // "Opening cash in the table above is the balance at the START of the
    // reporting period" — printed under a table whose Opening cash row
    // carried no marker at all, which is the sharpest of the twelve
    // unanchored notes because the sentence names the row out loud.
    const table = windowNotes.length === 0 ? cash : anchorRow(
      cash, (row) => row.label.toLowerCase() === 'opening cash', statementNotes.length + 1,
    );
    return page(cashTitle(set, scale), 'Cash', 'Financials', 'high',
      buildCashBlocks(table, cashBridge, line, set, scale), 'portrait', [
        ...statementNotes,
        ...windowNotes,
      ]);
  })();

let cashLine = cashTrend;
let cashPage = cashSheet(cashLine);
while (cashLine !== null && pageMm(cashPage) > pageBoxMm(cashPage)) {
  const shorter = shorterCashTrendChart(trend, scale, cashLine);
  if (shorter === null) break;
  cashLine = shorter;
  cashPage = cashSheet(cashLine);
}

  return cashPage;
}
