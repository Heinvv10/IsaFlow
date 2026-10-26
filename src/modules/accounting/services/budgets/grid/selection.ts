/**
 * Grid geometry. Rows are every rendered row (sections, lines, subtotals,
 * profit totals); only `line` rows hold focusable cells. Columns are the
 * focusable ones: the year's months, then the FY total (the last column).
 */

export type RowKind = 'section' | 'line' | 'subtotal' | 'total' | 'grand';
export type Dir = 'up' | 'down' | 'left' | 'right';

export interface Pos { r: number; c: number }
export interface Selection { anchor: Pos; focus: Pos }
export interface Rect { top: number; left: number; bottom: number; right: number }

export interface GridShape {
  rowKinds: readonly RowKind[];
  /** Month columns + 1 (the FY total). */
  cols: number;
}

export function lineRows(shape: GridShape): number[] {
  const out: number[] = [];
  shape.rowKinds.forEach((k, r) => { if (k === 'line') out.push(r); });
  return out;
}

export const isLine = (shape: GridShape, r: number): boolean => shape.rowKinds[r] === 'line';

export function normalise(a: Pos, b: Pos): Rect {
  return { top: Math.min(a.r, b.r), left: Math.min(a.c, b.c), bottom: Math.max(a.r, b.r), right: Math.max(a.c, b.c) };
}

export const extend = (sel: Selection, to: Pos): Selection => ({ anchor: sel.anchor, focus: to });

/** Line-row cells of `rect`, clipped to the grid, row-major. */
export function cellsIn(rect: Rect, shape: GridShape): Pos[] {
  const out: Pos[] = [];
  const bottom = Math.min(rect.bottom, shape.rowKinds.length - 1);
  const right = Math.min(rect.right, shape.cols - 1);
  for (let r = Math.max(0, rect.top); r <= bottom; r++) {
    if (!isLine(shape, r)) continue;
    for (let c = Math.max(0, rect.left); c <= right; c++) out.push({ r, c });
  }
  return out;
}

export function clampToEditable(rect: Rect, shape: GridShape, editable: (p: Pos) => boolean): Pos[] {
  return cellsIn(rect, shape).filter(editable);
}

/** `steps` line rows up/down (stopping at the last one), or `steps` columns left/right (clamped). */
export function nextFocusable(pos: Pos, dir: Dir, shape: GridShape, steps = 1): Pos {
  if (dir === 'left' || dir === 'right') {
    const c = pos.c + (dir === 'right' ? steps : -steps);
    return { r: pos.r, c: Math.max(0, Math.min(shape.cols - 1, c)) };
  }
  const rows = lineRows(shape);
  if (rows.length === 0) return pos;
  let i = rows.indexOf(pos.r);
  if (i < 0) {
    // Off a line row (should not happen): start between the line rows around it.
    const before = rows.filter(r => r < pos.r).length;
    i = dir === 'down' ? before - 1 : before;
  }
  const to = Math.max(0, Math.min(rows.length - 1, i + (dir === 'down' ? steps : -steps)));
  return { r: rows[to] ?? pos.r, c: pos.c };
}

/** Ctrl+arrow: the first/last focusable cell in that direction. */
export function edgeFocusable(pos: Pos, dir: Dir, shape: GridShape): Pos {
  const rows = lineRows(shape);
  switch (dir) {
    case 'left': return { r: pos.r, c: 0 };
    case 'right': return { r: pos.r, c: shape.cols - 1 };
    case 'up': return { r: rows[0] ?? pos.r, c: pos.c };
    default: return { r: rows[rows.length - 1] ?? pos.r, c: pos.c };
  }
}
