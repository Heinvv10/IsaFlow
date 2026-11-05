/**
 * Page 6 with its Budget and Variance columns, when it can carry them (budgets P3 PR-E).
 *
 * The columns name their budget in a footnote numbered after the shared statement notes, and the
 * sheet's own notes follow it. Eight data columns leave the label column less room, and at very
 * large figures (a net-debit revenue in the tens of billions, adversarial review r2) no bridge rung
 * fits the sheet: `fitPageToBox` would refuse the WHOLE pack. A budget is a comparison the pack can
 * do without; the pack is not. So the sheet is tried with the columns and, when it cannot be made
 * to fit, composed without them, and that is logged.
 *
 * THE CAPTION GOES BEFORE THE COLUMNS. `fitPageToBox` takes page 6's derived caption FIRST, before any
 * footnote, and the footnote that names the Budget columns is one it may then keep. A budget company whose
 * columns used to be left out because the page was a caption too tall keeps them and loses the caption
 * (figures over derived prose); counted over the 2,560-shape sweep by `packFitterAnchorsSweep`.
 */
import { log } from '@/lib/logger';
import type { MoneyScale } from '@/lib/format/money';
import type { PackFigureSet } from '@/modules/accounting/services/packs/figures/packFigureSet';
import { PackRefusal } from '@/modules/accounting/services/packs/packRefusal';
import type { UnnumberedPage } from './packFrontMatter';
import { buildIncomeStatementSheet } from './packIncomeSheet';
import { fitPageReport, fitPageToBox } from './packPageFit';
import { tookSomething } from './packOmissionFootnote';
import type { PackChartSpec, PackFootnote, PackTable } from './packPageModel';
import { budgetColumnFootnote } from './packStatementFootnotes';
import { anchorColumn } from './packStatementTables';

/** Printed on page 6 when the columns are left out: the pack says what it left off rather than only logging it. */
export const BUDGET_COLUMNS_DROPPED_NOTE =
  'The Budget and Variance columns are left out of this page because the figures are too wide to fit it.';

const BUDGET_COLUMNS = new Set(['budget', 'variance']);

/** The table without its Budget and Variance columns or cells (the figures stay issued, unprinted). */
function withoutBudget(table: PackTable): PackTable {
  return {
    ...table,
    columns: table.columns.filter((c) => !BUDGET_COLUMNS.has(c)),
    columnNotes: table.columnNotes?.filter((n) => !BUDGET_COLUMNS.has(n.column)),
    rows: table.rows.map((row) => ({
      ...row,
      figures: Object.fromEntries(Object.entries(row.figures).filter(([c]) => !BUDGET_COLUMNS.has(c))),
    })),
  };
}

export function incomeSheetWithBudget(
  income: PackTable,
  set: PackFigureSet,
  scale: MoneyScale,
  panels: PackChartSpec[],
  statementNotes: PackFootnote[],
): UnnumberedPage {
  const budgetNotes = budgetColumnFootnote(set.budget, statementNotes.length + 1);
  if (budgetNotes.length === 0) return buildIncomeStatementSheet(income, set, scale, panels, statementNotes);
  const sheet = buildIncomeStatementSheet(
    anchorColumn(income, 'budget', budgetNotes[0]!.number), set, scale, panels, [...statementNotes, ...budgetNotes]);
  let diagnostic: string;
  try {
    const fitted = fitPageToBox(sheet);
    if (fitted.footnotes.some((note) => note.text === budgetNotes[0]!.text)) return fitted;
    diagnostic = 'fitPageToBox removed the footnote that explains the Budget and Variance columns';
  } catch (err) {
    if (!(err instanceof PackRefusal)) throw err;
    diagnostic = err.message;
  }
  log.warn('board pack: page 6 cannot fit the Budget and Variance columns at these figures; printed without them',
    { period: set.currentWindow, diagnostic }, 'packs');
  // The note is printed only where the page carries it AND everything it carried before: a page the
  // fitter would trim for it (dropping anchored notes) or refuse is composed as it was without the note.
  const droppedNote: PackFootnote = { number: statementNotes.length + 1, text: BUDGET_COLUMNS_DROPPED_NOTE, required: true };
  const noted = buildIncomeStatementSheet(withoutBudget(income), set, scale, panels, [...statementNotes, droppedNote]);
  try {
    if (!tookSomething(fitPageReport(noted).dropped)) return noted;
  } catch (err) {
    if (!(err instanceof PackRefusal)) throw err;
  }
  return buildIncomeStatementSheet(withoutBudget(income), set, scale, panels, statementNotes);
}
