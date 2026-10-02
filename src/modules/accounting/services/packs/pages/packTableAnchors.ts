/**
 * The two functions that stamp a numbered footnote's marker onto the row or
 * the column heading it is about. Split out of `packStatementTables.ts` for
 * the 300-line cap; that file re-exports both, so every caller still imports
 * them there.
 */
import type { PackTable, PackTableColumnKey, PackTableRow } from './packPageModel';

/**
 * ANCHORING A NUMBERED FOOTNOTE TO THE THING IT IS ABOUT.
 *
 * The pack ran two footnote systems and only the lettered one worked: every
 * `n/m` mark points at its reason, and the numbered notes at the foot of
 * pages 5 to 8 pointed at nothing at all. "Opening cash in the table above is
 * the balance at the START of the reporting period" printed under a table
 * whose Opening cash row carried no marker; "The prior column is the period
 * 26 April 2025 to 31 December 2025" printed under a column heading that said
 * only "Prior".
 *
 * These two stamp the marker on, and they are HERE rather than in the page
 * builder because the page builder is a sequence and this is a fact about a
 * table's shape. They take a predicate rather than a row index for the reason
 * `packStatementIdentities` takes one: a row's position moves with the
 * company's chart of accounts and its ROLE does not.
 *
 * A predicate matching nothing is not silently ignored — see `anchorRow`.
 */
export function anchorRow(
  table: PackTable,
  matches: (row: PackTableRow) => boolean,
  footnote: number,
): PackTable {
  const rows = table.rows.map((row) => (matches(row) ? { ...row, footnote } : row));
  if (rows.every((row, i) => row === table.rows[i])) {
    // A footnote whose anchor does not exist is the defect this function was
    // written to remove, so it fails loudly rather than printing the note
    // unanchored again. Every caller anchors a footnote the page is already
    // printing, so this is unreachable from the composer and is the guard
    // that keeps it so.
    throw new Error(`anchorRow: footnote ${footnote} matched no row of this table`);
  }
  return { ...table, rows };
}

export function anchorColumn(
  table: PackTable,
  column: PackTableColumnKey,
  footnote: number,
): PackTable {
  if (!table.columns.includes(column)) {
    throw new Error(`anchorColumn: footnote ${footnote} names a '${column}' column this table has no`);
  }
  return { ...table, columnNotes: [...(table.columnNotes ?? []), { column, footnote }] };
}
