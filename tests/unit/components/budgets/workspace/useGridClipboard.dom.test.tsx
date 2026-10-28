/**
 * useGridClipboard (spec §5.3): native copy / cut / paste ClipboardEvents (text/plain), no
 * clipboard-permission API; the paste is one undo entry with its announcement and refused cells;
 * while a cell is being edited the input keeps the native behaviour.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';
import { GridStore, accountRowKey } from '@/components/accounting/budgets/workspace/gridStore';
import { GridHarness } from './GridHarness';
import { ID, gridModel } from './gridFixture';

let store: GridStore;
beforeEach(() => {
  store = new GridStore();
  store.reset(gridModel(), { view: { kind: 'company' }, canWrite: true });
});
const r = (acct: string) => store.getLayout().rows.find(x => x.key === accountRowKey(acct))!.index;
const values = (acct: string) => store.getRow(accountRowKey(acct)).values;

function setup() {
  const view = render(<GridHarness store={store} />);
  const cell = (acct: string, c: number) => view.container.querySelector<HTMLElement>(`[data-pos="${r(acct)}:${c}"]`)!;
  return { ...view, cell };
}

describe('useGridClipboard', () => {
  it('paste writes the block at the focused cell as one undo entry and announces it', () => {
    const { cell } = setup();
    act(() => { fireEvent.mouseDown(cell(ID.kid2, 0)); });
    const getData = vi.fn(() => '1\t2\r\n3\tR 1 234,50\r\n4\t#N/A\r\n');
    const notPrevented = fireEvent.paste(cell(ID.kid2, 0), { clipboardData: { getData } });
    expect(notPrevented).toBe(false);
    expect(getData).toHaveBeenCalledWith('text/plain');
    expect(values(ID.kid2).slice(0, 2)).toEqual([100, 200]);
    expect(values(ID.opex).slice(0, 2)).toEqual([300, 123450]);
    expect(store.getMeta().announcement.text).toBe('Pasted 4 cells; 2 skipped (read-only)');
    act(() => { store.undo(); });
    expect(values(ID.kid2).slice(0, 2)).toEqual([null, null]);
    expect(values(ID.opex).slice(0, 2)).toEqual([null, null]);
  });

  it('copy puts the selection on the clipboard as TSV', () => {
    const { cell } = setup();
    act(() => { fireEvent.mouseDown(cell(ID.rev1, 0)); fireEvent.mouseDown(cell(ID.rev1, 2), { shiftKey: true }); });
    const setData = vi.fn();
    expect(fireEvent.copy(cell(ID.rev1, 2), { clipboardData: { setData } })).toBe(false);
    expect(setData).toHaveBeenCalledWith('text/plain', '1000.00\t0.00\t\n');
  });

  it('cut copies and clears the editable cells', () => {
    const { cell } = setup();
    act(() => { fireEvent.mouseDown(cell(ID.rev1, 0)); });
    const setData = vi.fn();
    fireEvent.cut(cell(ID.rev1, 0), { clipboardData: { setData } });
    expect(setData).toHaveBeenCalledWith('text/plain', '1000.00\n');
    expect(values(ID.rev1)[0]).toBeNull();
  });

  it('leaves the editor input its native paste', () => {
    const { cell, container } = setup();
    act(() => { fireEvent.mouseDown(cell(ID.rev2, 0)); });
    fireEvent.keyDown(cell(ID.rev2, 0), { key: 'F2' });
    const input = container.querySelector('input')!;
    const getData = vi.fn(() => '9');
    expect(fireEvent.paste(input, { clipboardData: { getData } })).toBe(true);
    expect(getData).not.toHaveBeenCalled();
    expect(values(ID.rev2)[0]).toBeNull();
  });
});
