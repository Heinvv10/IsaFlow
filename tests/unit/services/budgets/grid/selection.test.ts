/**
 * Grid geometry: focus moves only between line rows (section, subtotal and
 * profit rows are skipped vertically), ranges normalise, shift-extend keeps the
 * anchor, and only editable cells come out of a clamp.
 */
import { describe, it, expect } from 'vitest';
import {
  type GridShape, cellsIn, clampToEditable, edgeFocusable, extend, lineRows, nextFocusable, normalise,
} from '@/modules/accounting/services/budgets/grid/selection';

// 0 section, 1-2 lines, 3 subtotal, 4 GP, 5 section, 6-8 lines, 9 subtotal, 10 NP
const SHAPE: GridShape = {
  rowKinds: ['section', 'line', 'line', 'subtotal', 'total', 'section', 'line', 'line', 'line', 'subtotal', 'grand'],
  cols: 13,
};

describe('nextFocusable', () => {
  it.each([
    [{ r: 1, c: 0 }, 'down', { r: 2, c: 0 }],
    [{ r: 2, c: 4 }, 'down', { r: 6, c: 4 }],
    [{ r: 6, c: 4 }, 'up', { r: 2, c: 4 }],
    [{ r: 8, c: 0 }, 'down', { r: 8, c: 0 }],
    [{ r: 1, c: 0 }, 'up', { r: 1, c: 0 }],
    [{ r: 1, c: 0 }, 'left', { r: 1, c: 0 }],
    [{ r: 1, c: 12 }, 'right', { r: 1, c: 12 }],
    [{ r: 1, c: 5 }, 'right', { r: 1, c: 6 }],
  ] as const)('%o %s → %o', (pos, dir, to) => {
    expect(nextFocusable(pos, dir, SHAPE)).toEqual(to);
  });

  it('never lands on a non-line row', () => {
    for (const r of lineRows(SHAPE)) {
      for (const dir of ['up', 'down'] as const) {
        expect(SHAPE.rowKinds[nextFocusable({ r, c: 0 }, dir, SHAPE).r]).toBe('line');
      }
    }
  });

  it('moves n line rows (PageDown), stopping at the last', () => {
    expect(nextFocusable({ r: 1, c: 0 }, 'down', SHAPE, 3)).toEqual({ r: 7, c: 0 });
    expect(nextFocusable({ r: 1, c: 0 }, 'down', SHAPE, 20)).toEqual({ r: 8, c: 0 });
    expect(nextFocusable({ r: 8, c: 0 }, 'up', SHAPE, 20)).toEqual({ r: 1, c: 0 });
  });
});

describe('degenerate shapes', () => {
  const EMPTY: GridShape = { rowKinds: ['section', 'grand'], cols: 13 };

  it('a grid with no line rows keeps the position', () => {
    expect(nextFocusable({ r: 0, c: 2 }, 'down', EMPTY)).toEqual({ r: 0, c: 2 });
    expect(edgeFocusable({ r: 0, c: 2 }, 'up', EMPTY)).toEqual({ r: 0, c: 2 });
    expect(lineRows(EMPTY)).toEqual([]);
  });

  it('from a non-line row, moves to the nearest line row in that direction', () => {
    expect(nextFocusable({ r: 3, c: 1 }, 'down', SHAPE)).toEqual({ r: 6, c: 1 });
    expect(nextFocusable({ r: 3, c: 1 }, 'up', SHAPE)).toEqual({ r: 2, c: 1 });
  });
});

describe('edgeFocusable (Ctrl+arrow)', () => {
  it.each([
    ['down', { r: 8, c: 3 }],
    ['up', { r: 1, c: 3 }],
    ['left', { r: 6, c: 0 }],
    ['right', { r: 6, c: 12 }],
  ] as const)('%s → %o', (dir, to) => {
    expect(edgeFocusable({ r: 6, c: 3 }, dir, SHAPE)).toEqual(to);
  });
});

describe('ranges', () => {
  it('normalise orders the corners', () => {
    expect(normalise({ r: 7, c: 1 }, { r: 2, c: 5 })).toEqual({ top: 2, left: 1, bottom: 7, right: 5 });
  });

  it('extend keeps the anchor and moves the focus', () => {
    const sel = extend({ anchor: { r: 1, c: 1 }, focus: { r: 1, c: 1 } }, { r: 6, c: 3 });
    expect(sel).toEqual({ anchor: { r: 1, c: 1 }, focus: { r: 6, c: 3 } });
    expect(extend(sel, { r: 2, c: 0 }).anchor).toEqual({ r: 1, c: 1 });
  });

  it('cellsIn lists line-row cells only, row-major', () => {
    expect(cellsIn({ top: 2, left: 0, bottom: 6, right: 1 }, SHAPE)).toEqual([
      { r: 2, c: 0 }, { r: 2, c: 1 }, { r: 6, c: 0 }, { r: 6, c: 1 },
    ]);
  });

  it('clampToEditable keeps the editable cells and clips to the grid', () => {
    const editable = (p: { r: number; c: number }) => p.r !== 6;
    expect(clampToEditable({ top: 2, left: 11, bottom: 7, right: 20 }, SHAPE, editable)).toEqual([
      { r: 2, c: 11 }, { r: 2, c: 12 }, { r: 7, c: 11 }, { r: 7, c: 12 },
    ]);
  });
});
