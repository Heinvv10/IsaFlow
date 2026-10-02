/**
 * HOW WIDE EACH COLUMN OF THE MATTERS TABLE IS, IN MILLIMETRES.
 *
 * THE MODEL COULD NOT SEE THE TABLE IT WAS MEASURING. `mattersTableMm`
 * divided a notional 72 CHARACTERS across the columns and charged every row
 * its longest cell wrapped to that; Chromium laid the same table out under
 * `table-layout: auto`, which sizes a column from the content in it. On the
 * live demo company's page 11 the model charged 173.3mm for a table the
 * browser set in 95.0 — an over-charge of 78mm, four fifths of a page — so
 * the selector stopped at five of twenty-eight matters and printed
 * "23 further matters are not printed. This table is held to what the page
 * has room for" under half a sheet of white paper. The excuse was false and
 * the board business was withheld for nothing.
 *
 * A budget cannot be honest about a table whose column widths it does not
 * know, and it cannot know an `auto` layout's widths without laying the table
 * out. So the table stops being `auto`: `.pack-matters` is `table-layout:
 * fixed` and carries a `<colgroup>` built from THIS file, which is the same
 * arithmetic the height model wraps its cells to. One source of truth for
 * five column widths, imported by the renderer and by the ruler.
 *
 * Imported by `MattersTable` — a component reading a service constant, which
 * is the direction that keeps the two from drifting. The alternative, the one
 * this replaces, was each side keeping its own idea of the columns and the
 * print harness catching the disagreement three sheets later.
 */
import { PAGE_WIDTH_MM } from './packTextMetrics';

/** `.pack-matters` runs the full content box of a portrait sheet. */
export const MATTERS_TABLE_MM = PAGE_WIDTH_MM.portrait;

/** `.pack-table td` padding — 2mm each side; text is set across what is
 *  left of the column. */
export const MATTERS_CELL_PADDING_MM = 4;

/**
 * The quantum column, taken off the top: it is `white-space: nowrap` and its
 * own heading — "QUANTUM (R'000)", 8pt uppercase and letterspaced — is the
 * widest thing in it. Measured at 30.8mm and given 32.
 */
export const MATTERS_QUANTUM_MM = 32;

/** The issue column carries the matter itself, and is set at twice a prose
 *  column's measure. */
const ISSUE_SHARE = 2;

export interface MattersColumnsMm {
  issue: number;
  quantum: number;
  /** Each of the prose columns that are actually printed — a column every row
   *  answers identically is printed once as a note instead. */
  prose: number;
}

/** The widths for a table printing `proseColumns` of the three prose
 *  columns. */
export function mattersColumnsMm(proseColumns: number): MattersColumnsMm {
  const unit = (MATTERS_TABLE_MM - MATTERS_QUANTUM_MM) / (ISSUE_SHARE + proseColumns);
  return { issue: unit * ISSUE_SHARE, quantum: MATTERS_QUANTUM_MM, prose: unit };
}

/** The same widths as the percentages the `<colgroup>` states, in print
 *  order: issue, quantum, then one per printed prose column. */
export function mattersColumnPercents(proseColumns: number): string[] {
  const { issue, quantum, prose } = mattersColumnsMm(proseColumns);
  const pct = (mm: number): string => `${((mm / MATTERS_TABLE_MM) * 100).toFixed(3)}%`;
  return [pct(issue), pct(quantum), ...Array.from({ length: proseColumns }, () => pct(prose))];
}
