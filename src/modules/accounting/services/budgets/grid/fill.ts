/**
 * Where a paste or a fill writes (spec §5.3). Works in grid positions and
 * returns writes for the store to apply as ONE undo entry. Targets are line
 * rows (subtotal and profit rows are skipped, as navigation skips them) and
 * month columns only: the FY total column is derived, never written.
 * Read-only targets are skipped and counted; refused clipboard cells are listed.
 */
import type { ParsedCell } from './pasteParse';
import { type GridShape, type Pos, type Rect, cellsIn, lineRows } from './selection';

export interface FillGrid {
  shape: GridShape;
  isEditable(p: Pos): boolean;
  /** Current cents, null when not budgeted. */
  valueAt(p: Pos): number | null;
}

export interface CellWrite { pos: Pos; cents: number | null }
export interface InvalidCell { pos: Pos; raw: string; reason: string }
export interface FillResult { writes: CellWrite[]; skipped: number; invalid: InvalidCell[] }

const monthCols = (shape: GridShape): number => shape.cols - 1;

/** `rect` clipped to month columns. */
function monthRect(rect: Rect, shape: GridShape): Rect {
  return { ...rect, right: Math.min(rect.right, monthCols(shape) - 1) };
}

class Collector {
  readonly result: FillResult = { writes: [], skipped: 0, invalid: [] };
  constructor(private readonly g: FillGrid) {}

  put(pos: Pos, cell: ParsedCell): void {
    if (!this.g.isEditable(pos)) { this.result.skipped++; return; }
    if (cell.kind === 'error') { this.result.invalid.push({ pos, raw: cell.raw, reason: cell.reason }); return; }
    this.result.writes.push({ pos, cents: cell.kind === 'blank' ? null : cell.cents });
  }
}

const asCell = (cents: number | null): ParsedCell => (cents === null ? { kind: 'blank' } : { kind: 'value', cents });

export function pasteInto(rect: Rect, matrix: readonly (readonly ParsedCell[])[], g: FillGrid): FillResult {
  const out = new Collector(g);
  const months = monthCols(g.shape);
  const targets = cellsIn(monthRect(rect, g.shape), g.shape);
  const single = matrix.length === 1 && matrix[0].length === 1;
  if (single && targets.length > 1) {
    for (const pos of targets) out.put(pos, matrix[0][0]);
    return out.result;
  }
  const rows = lineRows(g.shape);
  const start = rows.findIndex(r => r >= rect.top);
  if (start < 0) return out.result;
  matrix.forEach((cells, i) => {
    const r = rows[start + i];
    if (r === undefined) return;
    cells.forEach((cell, j) => {
      const c = rect.left + j;
      if (c < months) out.put({ r, c }, cell);
    });
  });
  return out.result;
}

export function fillDown(rect: Rect, g: FillGrid): FillResult {
  const out = new Collector(g);
  const cells = cellsIn(monthRect(rect, g.shape), g.shape);
  const top = cells[0]?.r;
  for (const pos of cells) {
    if (pos.r !== top) out.put(pos, asCell(g.valueAt({ r: top, c: pos.c })));
  }
  return out.result;
}

export function fillRight(rect: Rect, g: FillGrid): FillResult {
  const out = new Collector(g);
  const r = monthRect(rect, g.shape);
  for (const pos of cellsIn(r, g.shape)) {
    if (pos.c !== r.left) out.put(pos, asCell(g.valueAt({ r: pos.r, c: r.left })));
  }
  return out.result;
}
