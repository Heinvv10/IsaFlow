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
import { unreadableBlock } from './packFigureFloor';
import { fitRelaidPage } from './packNarrativeFit';
import { BUDGET_COLUMNS_DROPPED_NOTE, warnCaptionDropped } from './packOmissionFootnote';
import type { PackChartSpec, PackFootnote, PackTable } from './packPageModel';
import { PACK_TABLE_COLUMN_LABEL } from './packTableModel';
import { budgetColumnFootnote } from './packStatementFootnotes';
import { anchorColumn } from './packStatementTables';

export { BUDGET_COLUMNS_DROPPED_NOTE };

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

/**
 * Page 6, composed as it always was; and, only where that page would be refused, once more with its two
 * required disclosures under one heading. A page that fits today (trimming included) is returned as it
 * was, byte for byte; a page refused either way is returned as the first composition so the refusal is
 * the one it always was.
 */
export function incomeSheetWithBudget(
  income: PackTable,
  set: PackFigureSet,
  scale: MoneyScale,
  panels: PackChartSpec[],
  statementNotes: PackFootnote[],
): UnnumberedPage {
  const apart = composedIncomeSheet(income, set, scale, panels, statementNotes, false);
  if (fitsItsSheet(apart)) return apart;
  const merged = composedIncomeSheet(income, set, scale, panels, statementNotes, true);
  return fitsItsSheet(merged) ? merged : apart;
}

function fitsItsSheet(sheet: UnnumberedPage): boolean {
  try {
    fitRelaidPage(sheet);
    return true;
  } catch (err) {
    if (!(err instanceof PackRefusal)) throw err;
    return false;
  }
}

function composedIncomeSheet(
  income: PackTable,
  set: PackFigureSet,
  scale: MoneyScale,
  panels: PackChartSpec[],
  statementNotes: PackFootnote[],
  merge: boolean,
): UnnumberedPage {
  const budgetNotes = budgetColumnFootnote(set.budget, statementNotes.length + 1);
  if (budgetNotes.length === 0) return buildIncomeStatementSheet(income, set, scale, panels, statementNotes, merge);
  const sheet = buildIncomeStatementSheet(
    anchorColumn(income, 'budget', budgetNotes[0]!.number), set, scale, panels, [...statementNotes, ...budgetNotes], merge);
  let diagnostic: string;
  try {
    const { page: fitted, dropped } = fitRelaidPage(sheet);
    if (unreadableBlock(fitted, scale) !== null) {
      // Eight data columns at these figures fit at no size down to the pack's smallest text: the columns go (a
      // budget is a comparison the pack can do without) before the pack is refused for them.
      diagnostic = 'the Budget and Variance columns make the figures too wide for the sheet at any legible size';
    } else if (fitted.footnotes.some((note) => note.text === budgetNotes[0]!.text)) {
      // This fitted page is the one used, so a caption it dropped is logged here.
      warnCaptionDropped('Income statement', dropped);
      return fitted;
    } else {
      diagnostic = 'fitPageToBox removed the footnote that explains the Budget and Variance columns';
    }
  } catch (err) {
    if (!(err instanceof PackRefusal)) throw err;
    diagnostic = err.message;
  }
  log.warn('board pack: page 6 cannot fit the Budget and Variance columns at these figures; printed without them',
    { period: set.currentWindow, diagnostic }, 'packs');
  // The columns are figures, so the page says they are not printed wherever that costs it no more than its
  // derived caption (the fitter's first lever: derived prose is worth less than a figure the reader is told
  // is missing). A page that would have to drop a note or a footnote (anchored ones included) or is refused
  // for it is composed as it was without the note (the #1121 ruling): see `columnsLeftOut` below.
  const droppedNote: PackFootnote = { number: statementNotes.length + 1, text: BUDGET_COLUMNS_DROPPED_NOTE, required: true };
  // `columnsLeftOut` here too: the page carries the dropped-columns note, but if the fit then has to print an
  // omission note (the caption went) that note must not say every figure is complete either.
  const noted: UnnumberedPage = {
    ...buildIncomeStatementSheet(withoutBudget(income), set, scale, panels, [...statementNotes, droppedNote], merge),
    columnsLeftOut: [PACK_TABLE_COLUMN_LABEL.budget, PACK_TABLE_COLUMN_LABEL.variance],
  };
  try {
    const { page: fitted, dropped } = fitRelaidPage(noted);
    if (dropped.notes === 0 && dropped.footnotes === 0 && dropped.requiredNotes === 0) {
      warnCaptionDropped('Income statement', dropped);
      return fitted;
    }
  } catch (err) {
    if (!(err instanceof PackRefusal)) throw err;
  }
  // The columns are figures left out of this page: if the fitter has to print an omission note on it, the
  // note names them (`PackPage.columnsLeftOut`).
  return {
    ...buildIncomeStatementSheet(withoutBudget(income), set, scale, panels, statementNotes, merge),
    columnsLeftOut: [PACK_TABLE_COLUMN_LABEL.budget, PACK_TABLE_COLUMN_LABEL.variance],
  };
}
