/**
 * BudgetGrid round-2 fixes (PR-C fix verification): Shift+Tab at column 0 keeps a refused draft
 * open like Enter / Tab; a draft whose cell turned read-only mid-edit is not re-opened (the
 * read-only reason is announced); the editor's error never sits under the sticky account column;
 * Shift+F10 / the context-menu key on a cell opens that row's actions.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { BudgetGrid, type BudgetGridProps } from '@/components/accounting/budgets/workspace/BudgetGrid';
import { GridStore, accountRowKey } from '@/components/accounting/budgets/workspace/gridStore';
import { cellKey } from '@/modules/accounting/services/budgets/grid/cellKey';
import { ID, MONTHS, gridModel } from './gridFixture';

const COMPANY = { kind: 'company' } as const;
const key = (acct: string, m: number) => cellKey({ glAccountId: acct, cc1Id: null, cc2Id: null, buId: null, month: MONTHS[m]! });

let store: GridStore;
beforeEach(() => {
  store = new GridStore();
  store.reset(gridModel(), { view: COMPANY, canWrite: true });
});

function mount(over: Partial<BudgetGridProps> = {}) {
  const props: BudgetGridProps = {
    store, view: COMPANY, roundingUnit: 1, density: 'accountant', showPy: true, compareLabel: null,
    canWrite: true, members: [], onSave: vi.fn(), onExit: vi.fn(() => false), ...over,
  };
  return render(<BudgetGrid {...props} />);
}
const rowIndex = (acct: string) => store.getLayout().rows.find(r => r.key === accountRowKey(acct))!.index;
const cell = (acct: string, c: number) => document.querySelector<HTMLElement>(`[data-pos="${rowIndex(acct)}:${c}"]`)!;
const editor = () => screen.queryByRole('textbox', { name: /budget$/ });
const keyPrevented = (el: HTMLElement, init: Record<string, unknown>) => !fireEvent.keyDown(el, init);
const typeInto = (acct: string, c: number, text: string) => {
  fireEvent.mouseDown(cell(acct, c), { button: 0 });
  fireEvent.keyDown(cell(acct, c), { key: '1' });
  fireEvent.change(editor()!, { target: { value: text } });
};

describe('Shift+Tab at column 0 with a refused draft', () => {
  it('keeps the editor open with the reason, writes nothing, and does not leave the grid', () => {
    mount();
    typeInto(ID.rev2, 0, '1,234');
    expect(keyPrevented(editor()!, { key: 'Tab', shiftKey: true })).toBe(true);
    expect(editor()).toHaveValue('1,234');
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(store.valueAt(key(ID.rev2, 0))).toBeNull();
  });
});

describe('a cell that became read-only mid-edit', () => {
  it('is not re-opened on a refused commit; the read-only reason is announced', () => {
    mount();
    typeInto(ID.rev1, 0, '55');
    act(() => { store.setView({ kind: 'cc1', memberId: ID.m1 }); }); // rev1 is company grain: read-only here
    fireEvent.keyDown(editor()!, { key: 'Enter' });
    expect(editor()).toBeNull();
    expect(screen.getByTestId('grid-announcement')).toHaveTextContent('Budgeted at company level');
    expect(store.valueAt(key(ID.rev1, 0))).toBe(100000);
  });
});

describe('the editor error is never under the sticky account column', () => {
  it('opens to the right in the first half of the year and to the left in the second, above the sticky column', () => {
    mount();
    typeInto(ID.rev2, 0, '1,234');
    fireEvent.keyDown(editor()!, { key: 'Enter' });
    const early = screen.getByRole('alert');
    expect(early.className).toContain('left-0');
    expect(early.className).toContain('z-[15]');
    fireEvent.keyDown(editor()!, { key: 'Escape' });
    typeInto(ID.rev2, 10, '1,234');
    fireEvent.keyDown(editor()!, { key: 'Enter' });
    expect(screen.getByRole('alert').className).toContain('right-0');
  });
});

describe('row actions from the keyboard', () => {
  it.each([{ key: 'F10', shiftKey: true }, { key: 'ContextMenu' }])('$key on a cell opens that row\'s actions', async (init) => {
    mount();
    fireEvent.mouseDown(cell(ID.rev2, 3), { button: 0 });
    expect(keyPrevented(cell(ID.rev2, 3), init)).toBe(true);
    expect(await screen.findByRole('menuitem', { name: 'Spread across months…' })).toBeInTheDocument();
  });
});

describe('notice heading counts cells, not entries', () => {
  it('a past-the-end entry for 4 cells plus one refused cell: "5 cells need a look"', () => {
    mount();
    act(() => { store.setNotice([{ rowLabel: 'Past the end of the grid', monthLabel: '', raw: '', reason: '4 pasted cells fell past the end.', cells: 4 }]); });
    expect(screen.getByRole('status')).toHaveTextContent('4 cells need a look');
    act(() => { store.addNotice([{ rowLabel: '1010 Account 1010', monthLabel: 'Mar 2026', raw: '1,234', reason: 'Ambiguous.' }]); });
    expect(screen.getByRole('status')).toHaveTextContent('5 cells need a look');
  });
  it('one refused cell: "1 cell needs a look"', () => {
    mount();
    act(() => { store.setNotice([{ rowLabel: '1010 Account 1010', monthLabel: 'Mar 2026', raw: 'x', reason: 'Not a number.', cells: 1 }]); });
    expect(screen.getByRole('status')).toHaveTextContent('1 cell needs a look');
  });
});
