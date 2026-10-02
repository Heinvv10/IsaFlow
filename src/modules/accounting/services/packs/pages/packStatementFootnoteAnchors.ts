/**
 * The two numbered footnotes every statement page carries, and the functions
 * that stamp their markers on. Lifted out of `buildBoardPackPages` whole for
 * the 300-line cap: the statements below are the composer's own, unchanged,
 * and it calls this where they stood.
 */
import { anchorColumn, anchorRow } from './packStatementTables';
import type { PackComparativePeriod, PackTable } from './packPageModel';

export function statementFootnoteAnchors(comparativePeriod: PackComparativePeriod | null): {
  ROUNDING_FOOTNOTE: number;
  anchorRounding: (table: PackTable) => PackTable;
  anchorPrior: (table: PackTable) => PackTable;
} {
  // EVERY NUMBERED FOOTNOTE GETS THE SUPERSCRIPT IT PROMISES.
  //
  // The pack ran two footnote systems and only the lettered one worked: on
  // the live demo pack TWELVE numbered notes printed at the feet of pages 5
  // to 9 and not one had a marker anywhere on its sheet. Page 3's has always
  // been anchored, through `PackKpiTile.trendFootnote`, which is what made
  // the rest look deliberate.
  //
  // The numbers are fixed by `statementFootnotes`: 1 is the rounding note on
  // every statement page and 2 is the prior column's period, present only
  // where there IS a comparative. They are stamped here rather than in the
  // table builders because the NUMBER is a property of the page, and
  // `anchorRow` throws if the row it names is not there — an anchor that
  // silently matches nothing is the defect this replaces.
  const ROUNDING_FOOTNOTE = 1;
  const PRIOR_COLUMN_FOOTNOTE = 2;
  /** The rounding note belongs on the row a reader's addition lands on. */
  const anchorRounding = (table: PackTable): PackTable => {
    const last = [...table.rows].reverse()
      .find((row) => row.role === 'total' || row.role === 'grandTotal');
    return last === undefined ? table : anchorRow(table, (row) => row === last, ROUNDING_FOOTNOTE);
  };
  /** And the comparative's period belongs on the column heading that claims
   *  it — the one thing in the pack a footnote is about that is not a row. */
  const anchorPrior = (table: PackTable): PackTable => (
    comparativePeriod === null ? table : anchorColumn(table, 'prior', PRIOR_COLUMN_FOOTNOTE)
  );
  return { ROUNDING_FOOTNOTE, anchorRounding, anchorPrior };
}
