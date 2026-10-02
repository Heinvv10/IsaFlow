/**
 * The TABLE types — a pack table's columns, rows and column notes, and the
 * header each column prints. Split from `packBlockModel.ts` at the 300-line
 * cap; that file re-exports every name below, so no caller moved.
 */
import type { PackFigure } from '@/modules/accounting/services/packs/figures/packFigureProvenance';

/**
 * The columns a pack table may carry. Stated once per table, in `columns`.
 *
 * TWO FAMILIES, AND A TABLE USES ONE OF THEM. The first seven are the
 * COMPARATIVE columns — one measure per row, read across periods. The five
 * below them are MEASURE columns, for a table whose rows are periods rather
 * than lines: page 5's month-by-month results. A table mixing the two would
 * be claiming a row is both a line and a month.
 */
export type PackTableColumnKey =
  | 'actual'
  | 'prior'
  | 'change'
  | 'changePct'
  | 'pctOfRevenue'
  | 'budget'
  | 'variance'
  | 'revenue'
  | 'otherIncome'
  | 'costOfSales'
  | 'monthOperatingExpenses'
  | 'otherExpenses'
  | 'netProfit';

export interface PackTableRow {
  label: string;
  /**
   * The row's stable identity — `is.revenue`, `bs.currentAssets` — as the
   * table's own builder names it.
   *
   * Carried because a page has to classify rows without reading their prose:
   * page 6's sign check asks which lines are INCOME and which are COST, and a
   * classification driven by a regex over labels is one rewording away from
   * putting operating profit in the cost band. Absent on a table whose
   * builder does not name its rows.
   */
  key?: string;
  /** 0-2. Indentation carries hierarchy — a sub-account nests under its
   *  section without restating the section name on every row. */
  level: 0 | 1 | 2;
  role: 'line' | 'subtotal' | 'total' | 'grandTotal';
  /** One figure per column this row has a value for — a subtotal row may
   *  carry only `actual` and `prior`, never a synthesised `change`. */
  figures: Partial<Record<PackTableColumnKey, PackFigure>>;
  /**
   * Index into the page's numbered `footnotes`, where one is ABOUT this row.
   *
   * The pack ran two footnote systems and only the lettered one worked. The
   * `n/m` marks have always pointed at their reasons; the NUMBERED footnotes
   * at the foot of pages 5 to 9 pointed at nothing — twelve of them on the
   * demo pack, every one unanchored, including "Opening cash in the table
   * above is the balance at the START of the reporting period" printed under
   * a table whose Opening cash row carried no marker. A numbered note with no
   * superscript is a promise the page does not keep, and it is the same
   * defect the pack twice fixed by DELETING an orphan footnote.
   *
   * Same shape and name as `PackScorecardRow.footnote`, which page 9 has
   * always used correctly, so there is one convention rather than two.
   */
  footnote?: number;
}

/**
 * The header each column prints, in the pack's own words.
 *
 * On the MODEL rather than in `ComparativeTable`, where it was: the rendered
 * text layer is checked against these strings (`packTextLayer.ts`), and a gate
 * that keeps its own copy of the labels is a gate that passes a table printing
 * something else.
 */
/** A numbered footnote anchored to a column heading — see
 *  `PackTable.columnNotes`. */
export interface PackTableColumnNote {
  column: PackTableColumnKey;
  footnote: number;
}

export const PACK_TABLE_COLUMN_LABEL: Record<PackTableColumnKey, string> = {
  actual: 'Actual',
  prior: 'Prior',
  change: 'Change',
  changePct: 'Change %',
  pctOfRevenue: '% of Revenue',
  budget: 'Budget',
  variance: 'Variance',
  revenue: 'Revenue',
  otherIncome: 'Other income',
  costOfSales: 'Cost of sales',
  // SHORT, because a column heading is set in 7pt letter-spaced caps over a
  // 26mm measure and `TABLE_HEAD_MM` budgets ONE line for it. "Operating
  // expenses" takes two there; "Operating" does not, and the row it heads is
  // named in full in the page's own note.
  monthOperatingExpenses: 'Operating',
  otherExpenses: 'Other',
  netProfit: 'Net profit',
};

export interface PackTable {
  /** Stated once, in the header — e.g. "R'000" — never repeated per cell. */
  scale: string;
  columns: readonly PackTableColumnKey[];
  rows: PackTableRow[];
  /**
   * Numbered footnotes anchored to a COLUMN HEADER rather than to a row.
   *
   * "The prior column is the period 26 April 2025 to 31 December 2025 — 250
   * days" is a statement about a column, and there is no row to hang it on:
   * it qualifies every cell under one heading. Anchoring it to the heading is
   * what the sentence already claims in words, and it is the only one of the
   * numbered footnotes whose subject is not a row or a note.
   */
  columnNotes?: readonly PackTableColumnNote[];
}
