/**
 * BudgetGrid (spec §14 component row, §5, §6.5, §11, §12): grid roles, roving tabindex,
 * aria-readonly on a locked version and on a header roll-up, the dirty marker; and the mouse /
 * key wiring through the real store and the core keyboard hook (click focus, shift-click range,
 * double-click edit, type-to-edit commits through the store), plus row actions that write one
 * undo entry through PR-A's spread functions.
 *
 * Mutation (§14): tabIndex=0 on every cell turns "roving tabindex" red.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { BudgetGrid, type BudgetGridProps } from '@/components/accounting/budgets/workspace/BudgetGrid';
import { GridStore, accountRowKey, rollupRowKey } from '@/components/accounting/budgets/workspace/gridStore';
import { cellKey } from '@/modules/accounting/services/budgets/grid/cellKey';
import { ID, MONTHS, gridModel } from './gridFixture';

const COMPANY = { kind: 'company' } as const;
const key = (acct: string, m: number, cc1Id: string | null = null) =>
  cellKey({ glAccountId: acct, cc1Id, cc2Id: null, buId: null, month: MONTHS[m]! });

let store: GridStore;
beforeEach(() => {
  store = new GridStore();
  store.reset(gridModel(), { view: COMPANY, canWrite: true });
});

function mount(over: Partial<BudgetGridProps> = {}) {
  const props: BudgetGridProps = {
    store, view: COMPANY, roundingUnit: 1, density: 'accountant', showPy: true, compareLabel: null,
    canWrite: true, members: [], onSave: vi.fn(), onExit: vi.fn(), ...over,
  };
  return { ...render(<BudgetGrid {...props} />), props };
}

const rowIndex = (rowKey: string) => store.getLayout().rows.find(r => r.key === rowKey)!.index;
const cell = (rowKey: string, c: number) => {
  const el = document.querySelector<HTMLElement>(`[data-pos="${rowIndex(rowKey)}:${c}"]`);
  if (!el) throw new Error(`no cell ${rowKey}:${c}`);
  return el;
};
const focusables = () => Array.from(document.querySelectorAll<HTMLElement>('[data-pos]'));

describe('roles and ARIA', () => {
  it('is a grid with row/col counts, month column headers, row headers and gridcells', () => {
    mount();
    const grid = screen.getByRole('grid', { name: 'Budget' });
    expect(grid).toHaveAttribute('aria-rowcount', String(store.getLayout().rows.length + 1));
    expect(screen.getByRole('columnheader', { name: 'March 2026' })).toHaveTextContent('Mar 26');
    expect(screen.getByRole('rowheader', { name: /1000\s*Account 1000/ })).toBeInTheDocument();
    expect(screen.getByRole('rowheader', { name: 'Gross profit' })).toBeInTheDocument();
    // 9 accounts → 8 non-header lines + 1 roll-up line, each 12 months + FY.
    expect(focusables()).toHaveLength(9 * 13);
    expect(cell(accountRowKey(ID.rev1), 0)).toHaveAttribute('role', 'gridcell');
  });

  it('roving tabindex: exactly one focusable cell has tabIndex 0, and it follows a click', () => {
    mount();
    const zero = () => focusables().filter(el => el.tabIndex === 0);
    expect(zero()).toHaveLength(1);
    fireEvent.mouseDown(cell(accountRowKey(ID.cos1), 3), { button: 0 });
    expect(zero()).toEqual([cell(accountRowKey(ID.cos1), 3)]);
    expect(document.activeElement).toBe(cell(accountRowKey(ID.cos1), 3));
  });

  it('aria-readonly: a header roll-up is read-only with its reason; editable lines are not', () => {
    mount();
    expect(cell(rollupRowKey(ID.hdr), 0)).toHaveAttribute('aria-readonly', 'true');
    expect(cell(rollupRowKey(ID.hdr), 0)).toHaveAttribute('title', 'Sub-account roll-up');
    expect(cell(accountRowKey(ID.rev1), 0)).toHaveAttribute('aria-readonly', 'false');
    // Subtotal cells are readable, never focusable.
    const gp = screen.getByRole('rowheader', { name: 'Gross profit' }).closest('tr')!;
    expect(gp).toHaveAttribute('aria-readonly', 'true');
    expect(within(gp).getByRole('gridcell', { name: /Gross profit, Mar 2026, R 600\.00/ })).toBeInTheDocument();
  });

  it('aria-readonly on every cell of a locked version', () => {
    store.reset(gridModel(), { view: COMPANY, canWrite: true, locked: true });
    mount({ canWrite: false });
    expect(focusables().every(el => el.getAttribute('aria-readonly') === 'true')).toBe(true);
    expect(cell(accountRowKey(ID.rev1), 0)).toHaveAttribute('title', 'Locked version');
  });

  it('money look: not budgeted renders empty, a budgeted zero renders the dash', () => {
    mount();
    expect(cell(accountRowKey(ID.rev1), 0)).toHaveTextContent('1 000.00');
    expect(cell(accountRowKey(ID.rev1), 1).textContent).toBe('–');
    expect(cell(accountRowKey(ID.rev1), 2).textContent).toBe('');
  });

  it('dirty marker: an edited cell carries the dirty token and data-dirty, an untouched one does not', () => {
    mount();
    act(() => { store.apply([{ key: key(ID.rev2, 4), cents: 123 }]); });
    const dirty = cell(accountRowKey(ID.rev2), 4);
    expect(dirty).toHaveAttribute('data-dirty', 'true');
    expect(dirty.className).toContain('bg-[var(--ff-dirty-bg)]');
    expect(cell(accountRowKey(ID.rev2), 3)).not.toHaveAttribute('data-dirty');
  });
});

describe('mouse and keys', () => {
  it('shift-click extends the selection from the anchor', () => {
    mount();
    fireEvent.mouseDown(cell(accountRowKey(ID.rev1), 1), { button: 0 });
    fireEvent.mouseDown(cell(accountRowKey(ID.rev2), 3), { button: 0, shiftKey: true });
    for (const rk of [accountRowKey(ID.rev1), accountRowKey(ID.rev2)]) {
      expect([0, 1, 2, 3, 4].map(c => cell(rk, c).getAttribute('aria-selected'))).toEqual(['false', 'true', 'true', 'true', 'false']);
    }
  });

  it('double-click opens the editor with the current value; Enter commits through the store', () => {
    mount();
    fireEvent.doubleClick(cell(accountRowKey(ID.rev1), 0));
    const editor = screen.getByRole('textbox', { name: '1000 Account 1000 Mar 2026 budget' });
    expect(editor).toHaveValue('1000.00');
    fireEvent.change(editor, { target: { value: '250' } });
    fireEvent.keyDown(editor, { key: 'Enter' });
    expect(store.getRow(accountRowKey(ID.rev1)).values[0]).toBe(250_00);
    expect(screen.queryByRole('textbox', { name: /budget$/ })).toBeNull();
  });

  it('typing a digit on a focused cell overwrites; Tab commits and the cell turns dirty', () => {
    mount();
    const target = cell(accountRowKey(ID.rev2), 2);
    fireEvent.mouseDown(target, { button: 0 });
    fireEvent.keyDown(target, { key: '7' });
    const editor = screen.getByRole('textbox', { name: /1010 Account 1010 May 2026 budget/ });
    expect(editor).toHaveValue('7');
    fireEvent.change(editor, { target: { value: '75' } });
    fireEvent.keyDown(editor, { key: 'Tab' });
    expect(store.getRow(accountRowKey(ID.rev2)).values[2]).toBe(75_00);
    expect(cell(accountRowKey(ID.rev2), 2)).toHaveAttribute('data-dirty', 'true');
  });

  it('a read-only cell does not edit on typing', () => {
    mount();
    const target = cell(rollupRowKey(ID.hdr), 0);
    fireEvent.mouseDown(target, { button: 0 });
    fireEvent.keyDown(target, { key: '5' });
    expect(screen.queryByRole('textbox', { name: /budget$/ })).toBeNull();
  });
});

describe('row actions', () => {
  it('Spread across months (even) writes the whole row as ONE undo entry', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Row actions for 1010 Account 1010' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Spread across months…' }));
    const dialog = await screen.findByRole('dialog');
    const amount = within(dialog).getByLabelText('Full-year amount');
    fireEvent.change(amount, { target: { value: '1200.05' } });
    fireEvent.blur(amount);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply' }));
    const values = store.getRow(accountRowKey(ID.rev2)).values;
    expect(values.slice(0, 11).every(v => v === 100_00)).toBe(true);
    expect(values[11]).toBe(100_05); // residue on the last month (spreadEven, decision 5)
    expect(store.getMeta().dirtyCount).toBe(12);
    act(() => { store.undo(); });
    expect(store.getRow(accountRowKey(ID.rev2)).values.every(v => v === null)).toBe(true);
    expect(store.getMeta().canUndo).toBe(false);
  });

  it('Clear row writes nulls for every held month in one entry', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Row actions for 1000 Account 1000' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Clear row' }));
    expect(store.getRow(accountRowKey(ID.rev1)).values.every(v => v === null)).toBe(true);
    act(() => { store.undo(); });
    expect(store.getRow(accountRowKey(ID.rev1)).values.slice(0, 2)).toEqual([100000, 0]);
  });

  it('Budget by CC1… clears the company grain and carries the amounts to the member in one batch', async () => {
    store.setView({ kind: 'cc1', memberId: ID.m1 });
    mount({ view: { kind: 'cc1', memberId: ID.m1 }, members: [{ id: ID.m1, code: 'CC-A', name: 'Alpha' }] });
    expect(cell(accountRowKey(ID.rev1), 0)).toHaveAttribute('aria-readonly', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Row actions for 1000 Account 1000' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Budget by CC1…' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('This clears R 1 000.00 across 2 months');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Change grain' }));
    expect(store.valueAt(key(ID.rev1, 0))).toBeNull();
    expect(store.valueAt(key(ID.rev1, 0, ID.m1))).toBe(100000);
    expect(store.valueAt(key(ID.rev1, 1, ID.m1))).toBe(0);
    expect(cell(accountRowKey(ID.rev1), 0)).toHaveAttribute('aria-readonly', 'false');
    act(() => { store.undo(); });
    expect(store.valueAt(key(ID.rev1, 0))).toBe(100000);
    expect(store.valueAt(key(ID.rev1, 0, ID.m1))).toBeNull();
  });
});

describe('legacy header own-budget chip (spec §6.5)', () => {
  /** The fixture's opex header, made legacy: it holds R 30 in March and R 10 in April itself. */
  function legacy() {
    const base = gridModel();
    store.reset(gridModel({
      accounts: base.accounts.map(a => (a.id === ID.hdr ? { ...a, ownAmounts: true } : a)),
      cells: [...base.cells,
        { glAccountId: ID.hdr, cc1Id: null, cc2Id: null, buId: null, month: MONTHS[0]!, amount: 30 },
        { glAccountId: ID.hdr, cc1Id: null, cc2Id: null, buId: null, month: MONTHS[1]!, amount: 10 }],
    }), { view: COMPANY, canWrite: true });
  }
  const chip = () => screen.getByRole('note');

  it('warns on the header row with its own total, and shows no chip on a header without own amounts', () => {
    mount();
    expect(screen.queryByRole('note')).toBeNull();
    legacy();
    mount();
    const headerRow = document.querySelector(`tr[data-row="${rollupRowKey(ID.hdr)}"]`)!;
    expect(within(headerRow as HTMLElement).getByRole('note')).toHaveTextContent('This header has its own R 40.00 budget');
  });

  it('Move to a sub-account: one batch deletes the header amounts and adds them to the child', async () => {
    legacy();
    mount();
    fireEvent.click(within(chip()).getByRole('button', { name: 'Move to a sub-account' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Sub-account'), { target: { value: ID.kid2 } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply' }));
    expect(store.valueAt(key(ID.hdr, 0))).toBeNull();
    expect(store.valueAt(key(ID.hdr, 1))).toBeNull();
    expect(store.valueAt(key(ID.kid2, 0))).toBe(30_00);
    expect(store.valueAt(key(ID.kid2, 1))).toBe(10_00);
    expect(screen.queryByRole('note')).toBeNull();
    act(() => { store.undo(); });
    expect(store.valueAt(key(ID.hdr, 0))).toBe(30_00);
    expect(store.valueAt(key(ID.kid2, 0))).toBeNull();
    expect(screen.getByRole('note')).toHaveTextContent('R 40.00');
  });

  it('Spread across sub-accounts: splits the own total over the children and clears the header, one entry', async () => {
    legacy();
    mount();
    fireEvent.click(within(chip()).getByRole('button', { name: 'Spread across sub-accounts' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('Amount to spread')).toHaveValue('40.00');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply' }));
    expect(store.valueAt(key(ID.hdr, 0))).toBeNull();
    const fy = (id: string) => store.getRow(accountRowKey(id)).fy;
    // kid1 already held R 50.50 in March; the spread replaces each child's year with its share.
    expect([fy(ID.kid1), fy(ID.kid2)]).toEqual([20_00, 20_00]);
    act(() => { store.undo(); });
    expect(store.valueAt(key(ID.hdr, 0))).toBe(30_00);
    expect(fy(ID.kid1)).toBe(50_50);
  });

  it('a viewer sees the warning without the actions', () => {
    legacy();
    mount({ canWrite: false });
    expect(chip()).toHaveTextContent('This header has its own');
    expect(within(chip()).queryByRole('button')).toBeNull();
  });
});
