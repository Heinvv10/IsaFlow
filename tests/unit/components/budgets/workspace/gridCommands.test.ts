/**
 * The grid's write commands (spec §5.2, §5.3, §5.5): commit a typed draft (the kit parser; a
 * refused amount is announced and never written), FY-total commit spreads evenly with the
 * rounding unit, clear, fill, copy/cut/paste — each one undo entry with its announcement.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { GridStore, accountRowKey } from '@/components/accounting/budgets/workspace/gridStore';
import {
  clearCells, commitDraft, copyText, cutText, fillCells, pasteText, redoLast, undoLast,
} from '@/components/accounting/budgets/workspace/gridCommands';
import { ID, gridModel } from './gridFixture';

let store: GridStore;
beforeEach(() => {
  store = new GridStore();
  store.reset(gridModel(), { view: { kind: 'company' }, canWrite: true });
});
const r = (rowKey: string) => store.getLayout().rows.find(x => x.key === rowKey)!.index;
const row = (acct: string) => store.getRow(accountRowKey(acct));
const announced = () => store.getMeta().announcement.text;

describe('commitDraft', () => {
  it('writes a parsed month amount as cents; a blank clears; a lone dash is a budgeted zero', () => {
    commitDraft(store, { r: r(accountRowKey(ID.rev2)), c: 0 }, 'R 1 234.50', false, 1);
    expect(row(ID.rev2).values[0]).toBe(123450);
    commitDraft(store, { r: r(accountRowKey(ID.rev2)), c: 1 }, '-', false, 1);
    expect(row(ID.rev2).values[1]).toBe(0);
    commitDraft(store, { r: r(accountRowKey(ID.rev2)), c: 0 }, '', false, 1);
    expect(row(ID.rev2).values[0]).toBeNull();
  });

  it('refuses an ambiguous amount with the parser reason and writes nothing', () => {
    commitDraft(store, { r: r(accountRowKey(ID.rev2)), c: 0 }, '1,234', false, 1);
    expect(row(ID.rev2).values[0]).toBeNull();
    expect(store.getMeta().canUndo).toBe(false);
    expect(announced()).not.toBe('');
  });

  it('FY total: spreads evenly with the rounding unit, residue on the last month, one undo entry', () => {
    commitDraft(store, { r: r(accountRowKey(ID.rev2)), c: 12 }, '1000', false, 100);
    // R1 000 over 12 months at R100: R100 a month for 11 months, the last takes the residue (−R100).
    expect(row(ID.rev2).values).toEqual([...Array(11).fill(10000), -10000]);
    expect(row(ID.rev2).fy).toBe(100000);
    expect(undoLast(store)).toBe(true);
    expect(row(ID.rev2).fy).toBeNull();
    expect(redoLast(store)).toBe(true);
    expect(row(ID.rev2).fy).toBe(100000);
  });

  it('isTotal from the reducer is honoured the same as the FY column', () => {
    commitDraft(store, { r: r(accountRowKey(ID.rev2)), c: 12 }, '12', true, 1);
    expect(row(ID.rev2).values.every(v => v === 100)).toBe(true);
  });

  it('a read-only cell is never written', () => {
    commitDraft(store, { r: r(accountRowKey(ID.dimAcc)), c: 0 }, '5', false, 1);
    expect(row(ID.dimAcc).values[0]).toBe(3000);
    expect(announced()).toMatch(/Roll-up of CC1/);
  });
});

describe('clear and fill', () => {
  it('clears every editable cell given, one undo entry, announced', () => {
    const a = r(accountRowKey(ID.rev1));
    clearCells(store, [{ r: a, c: 0 }, { r: a, c: 1 }]);
    expect(row(ID.rev1).values.slice(0, 2)).toEqual([null, null]);
    expect(announced()).toBe('Cleared 2 cells');
    undoLast(store);
    expect(row(ID.rev1).values.slice(0, 2)).toEqual([100000, 0]);
  });

  it('fill down copies the top row into editable rows below and counts the read-only ones', () => {
    const top = r(accountRowKey(ID.kid1));
    const bottom = r(accountRowKey(ID.dimAcc));
    fillCells(store, 'down', { top, left: 0, bottom, right: 0 });
    expect(row(ID.kid2).values[0]).toBe(5050);
    expect(row(ID.opex).values[0]).toBe(5050);
    expect(row(ID.dimAcc).values[0]).toBe(3000);
    expect(announced()).toBe('Filled 2 cells; 1 skipped (read-only)');
  });
});

describe('clipboard', () => {
  it('copies line rows × months as TSV, blank for not budgeted', () => {
    const a = r(accountRowKey(ID.rev1));
    expect(copyText(store, { top: a, left: 0, bottom: a + 1, right: 2 })).toBe('1000.00\t0.00\t\n\t\t\n');
  });

  it('cut copies, then clears the editable cells as one undo entry', () => {
    const a = r(accountRowKey(ID.rev1));
    expect(cutText(store, { top: a, left: 0, bottom: a, right: 1 })).toBe('1000.00\t0.00\n');
    expect(row(ID.rev1).values.slice(0, 2)).toEqual([null, null]);
    undoLast(store);
    expect(store.getMeta().canUndo).toBe(false);
  });

  it('pastes a block: one undo entry, read-only skipped, refused cells listed and announced', () => {
    const top = r(accountRowKey(ID.kid2));
    pasteText(store, { top, left: 0, bottom: top, right: 0 }, '1\t2\n3\tabc\n4\t5\n');
    expect(row(ID.kid2).values.slice(0, 2)).toEqual([100, 200]);
    expect(row(ID.opex).values.slice(0, 2)).toEqual([300, null]);
    expect(row(ID.dimAcc).values.slice(0, 2)).toEqual([3000, null]);
    expect(announced()).toBe('Pasted 3 cells; 2 skipped (read-only); 1 not a number (left unchanged)');
    expect(store.getMeta().notice).toEqual([{ rowLabel: '3100 Account 3100', monthLabel: 'Apr 2026', raw: 'abc', reason: expect.any(String) }]);
    undoLast(store);
    expect(row(ID.kid2).values.slice(0, 2)).toEqual([null, null]);
    expect(row(ID.opex).values[0]).toBeNull();
    expect(store.getMeta().canUndo).toBe(false);
  });

  it('a 1×1 clipboard fills every editable cell of the selection', () => {
    const top = r(accountRowKey(ID.rev2));
    pasteText(store, { top, left: 0, bottom: top, right: 3 }, '7');
    expect(row(ID.rev2).values.slice(0, 5)).toEqual([700, 700, 700, 700, null]);
    expect(announced()).toBe('Pasted 4 cells');
  });
});
