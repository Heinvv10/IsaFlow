/**
 * Paste and fill targets (spec §5.3): a 1×1 clipboard fills a multi-cell
 * selection, a block lands at the selection's top-left clipped to the month
 * columns, read-only targets are skipped and counted, refused cells are listed.
 */
import { describe, it, expect } from 'vitest';
import { type FillGrid, fillDown, fillRight, pasteInto } from '@/modules/accounting/services/budgets/grid/fill';
import { parseClipboard } from '@/modules/accounting/services/budgets/grid/pasteParse';
import type { Pos } from '@/modules/accounting/services/budgets/grid/selection';

// 0 section, 1-2 lines, 3 subtotal, 4 GP, 5 section, 6-8 lines, 9 subtotal, 10 NP; 3 months + FY total
const READONLY: Pos = { r: 6, c: 1 };
function grid(values: Record<string, number | null> = {}): FillGrid {
  return {
    shape: { rowKinds: ['section', 'line', 'line', 'subtotal', 'total', 'section', 'line', 'line', 'line', 'subtotal', 'grand'], cols: 4 },
    isEditable: p => !(p.r === READONLY.r && p.c === READONLY.c),
    valueAt: p => values[`${p.r},${p.c}`] ?? null,
  };
}
const rect = (top: number, left: number, bottom: number, right: number) => ({ top, left, bottom, right });
const writes = (r: ReturnType<typeof pasteInto>) => r.writes.map(w => [w.pos.r, w.pos.c, w.cents]);

describe('pasteInto', () => {
  it('a 1×1 clipboard fills every editable cell of a multi-cell selection', () => {
    const r = pasteInto(rect(2, 0, 6, 1), parseClipboard('5\n').rows, grid());
    expect(writes(r)).toEqual([[2, 0, 500], [2, 1, 500], [6, 0, 500]]);
    expect(r.skipped).toBe(1);
  });

  it('a block lands at the top-left and runs down line rows, skipping subtotal rows', () => {
    const r = pasteInto(rect(2, 0, 2, 0), parseClipboard('1\t2\n3\t4\n5\t6\n').rows, grid());
    expect(writes(r)).toEqual([[2, 0, 100], [2, 1, 200], [6, 0, 300], [7, 0, 500], [7, 1, 600]]);
    expect(r.skipped).toBe(1);
  });

  it('is clipped to the month columns (never the FY total) and the last line row', () => {
    const r = pasteInto(rect(7, 2, 7, 2), parseClipboard('1\t2\t3\n4\t5\t6\n7\t8\t9\n').rows, grid());
    expect(writes(r)).toEqual([[7, 2, 100], [8, 2, 400]]);
  });

  it('a blank clears the cell (null), never 0', () => {
    expect(writes(pasteInto(rect(1, 0, 1, 0), parseClipboard('\t0\n').rows, grid()))).toEqual([[1, 0, null], [1, 1, 0]]);
  });

  it('a refused cell is listed with its target and not written', () => {
    const r = pasteInto(rect(1, 0, 1, 0), parseClipboard('1,234\t2\n').rows, grid());
    expect(writes(r)).toEqual([[1, 1, 200]]);
    expect(r.invalid).toEqual([{ pos: { r: 1, c: 0 }, raw: '1,234', reason: expect.stringMatching(/ambiguous/i) }]);
  });

  it('a 1×1 clipboard into a single cell writes that cell only', () => {
    expect(writes(pasteInto(rect(1, 0, 1, 0), parseClipboard('9').rows, grid()))).toEqual([[1, 0, 900]]);
  });

  it('a read-only target is never written', () => {
    const r = pasteInto(rect(6, 1, 6, 1), parseClipboard('9').rows, grid());
    expect(r.writes).toEqual([]);
    expect(r.skipped).toBe(1);
  });
});

describe('fillDown / fillRight', () => {
  const g = grid({ '1,0': 100, '1,1': null, '1,2': 300, '2,0': 7 });

  it('fillDown copies the top line row to every line row below it in the range', () => {
    const r = fillDown(rect(1, 0, 6, 1), g);
    expect(writes(r)).toEqual([[2, 0, 100], [2, 1, null], [6, 0, 100]]);
    expect(r.skipped).toBe(1);
  });

  it('fillRight copies the left column across the range', () => {
    const r = fillRight(rect(1, 0, 2, 2), g);
    expect(writes(r)).toEqual([[1, 1, 100], [1, 2, 100], [2, 1, 7], [2, 2, 7]]);
  });

  it('never writes into the FY total column', () => {
    expect(writes(fillRight(rect(1, 0, 1, 3), g)).every(([, c]) => c !== 3)).toBe(true);
  });

  it('a one-row range has nothing to fill down', () => {
    expect(fillDown(rect(1, 0, 1, 2), g).writes).toEqual([]);
  });
});
