/**
 * useGridKeyboard (spec §5.2): real keydown / mousedown events on a grid built on the store
 * hooks, through PR-A `gridReducer`, into store writes and DOM focus (roving tabindex).
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
const value = (acct: string, c: number) => store.getRow(accountRowKey(acct)).values[c];

function setup(props: Partial<Parameters<typeof GridHarness>[0]> = {}) {
  const view = render(<GridHarness store={store} {...props} />);
  const cell = (acct: string, c: number) => view.container.querySelector<HTMLElement>(`[data-pos="${r(acct)}:${c}"]`)!;
  const editor = () => view.container.querySelector<HTMLInputElement>('input[aria-label="cell editor"]');
  const press = (key: string, init: Record<string, unknown> = {}) => fireEvent.keyDown(editor() ?? (document.activeElement as HTMLElement), { key, ...init });
  return { ...view, cell, editor, press };
}

describe('useGridKeyboard', () => {
  it('ArrowDown moves DOM focus to the next LINE row (subtotal and profit rows skipped)', () => {
    const { cell, press } = setup();
    act(() => { fireEvent.mouseDown(cell(ID.rev2, 2)); });
    press('ArrowDown');
    expect(document.activeElement).toBe(cell(ID.cos1, 2));
    expect(cell(ID.cos1, 2).tabIndex).toBe(0);
    expect(cell(ID.rev2, 2).tabIndex).toBe(-1);
  });

  it('typing overwrites, Enter commits the parsed amount and moves down', () => {
    const { cell, press, editor } = setup();
    act(() => { fireEvent.mouseDown(cell(ID.rev1, 0)); });
    expect(press('1')).toBe(false); // handled: preventDefault, so the key is not typed twice
    expect(editor()?.value).toBe('1');
    fireEvent.change(editor()!, { target: { value: '12.5' } });
    press('Enter');
    expect(value(ID.rev1, 0)).toBe(1250);
    expect(editor()).toBeNull();
    expect(document.activeElement).toBe(cell(ID.rev2, 0));
  });

  it('Escape cancels the draft; the value is unchanged', () => {
    const { cell, press, editor } = setup();
    act(() => { fireEvent.mouseDown(cell(ID.rev1, 0)); });
    press('F2');
    expect(editor()?.value).toBe('1000.00');
    fireEvent.change(editor()!, { target: { value: '5' } });
    press('Escape');
    expect(value(ID.rev1, 0)).toBe(100000);
    expect(store.getMeta().dirtyCount).toBe(0);
  });

  it('Ctrl+S (and ⌘S) saves with preventDefault', () => {
    const onSave = vi.fn();
    const { cell, press } = setup({ onSave });
    act(() => { fireEvent.mouseDown(cell(ID.rev1, 0)); });
    expect(press('s', { ctrlKey: true })).toBe(false);
    expect(press('s', { metaKey: true })).toBe(false);
    expect(onSave).toHaveBeenCalledTimes(2);
  });

  it('Shift+Arrow extends the selection; Delete clears it as one entry; Ctrl+Z undoes', () => {
    const { cell, press } = setup();
    act(() => { fireEvent.mouseDown(cell(ID.rev1, 0)); });
    press('ArrowRight', { shiftKey: true });
    expect(cell(ID.rev1, 1).getAttribute('aria-selected')).toBe('true');
    press('Delete');
    expect([value(ID.rev1, 0), value(ID.rev1, 1)]).toEqual([null, null]);
    expect(store.getMeta().announcement.text).toBe('Cleared 2 cells');
    press('z', { ctrlKey: true });
    expect([value(ID.rev1, 0), value(ID.rev1, 1)]).toEqual([100000, 0]);
  });

  it('a commit in the FY total column spreads evenly with the toolbar rounding unit', () => {
    const { cell, press, editor } = setup({ unit: 100 });
    act(() => { fireEvent.mouseDown(cell(ID.rev2, 12)); });
    press('1');
    fireEvent.change(editor()!, { target: { value: '1200' } });
    press('Enter');
    expect(store.getRow(accountRowKey(ID.rev2)).values).toEqual(Array(12).fill(10000));
  });

  it('typing on a read-only cell announces why and opens no editor', () => {
    const { cell, press, editor } = setup();
    act(() => { fireEvent.mouseDown(cell(ID.dimAcc, 0)); });
    press('5');
    expect(editor()).toBeNull();
    expect(store.getMeta().announcement.text).toMatch(/Roll-up of CC1/);
  });

  it('Tab off the FY column exits; a blur commits without pulling focus back', () => {
    const onExit = vi.fn();
    const { cell, press, editor } = setup({ onExit });
    act(() => { fireEvent.mouseDown(cell(ID.rev2, 12)); });
    press('Tab');
    expect(onExit).toHaveBeenCalledTimes(1);
    act(() => { fireEvent.mouseDown(cell(ID.rev2, 0)); });
    press('4');
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    act(() => { outside.focus(); fireEvent.blur(editor()!); });
    expect(value(ID.rev2, 0)).toBe(400);
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  it('Ctrl+D fills down from the top row of a mouse-dragged range', () => {
    const { cell, press } = setup();
    act(() => { fireEvent.mouseDown(cell(ID.kid1, 0)); fireEvent.mouseEnter(cell(ID.opex, 0)); fireEvent.mouseUp(window); });
    press('d', { ctrlKey: true });
    expect([value(ID.kid2, 0), value(ID.opex, 0)]).toEqual([5050, 5050]);
  });
});
