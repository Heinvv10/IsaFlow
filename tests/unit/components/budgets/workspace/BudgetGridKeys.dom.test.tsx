/**
 * BudgetGrid round-1 fixes (PR-C review): no keyboard trap (QA-1), a refused typed amount keeps the
 * editor open with its reason (QA-4), a double-click inside the editor keeps the draft (QA-5), a
 * cell's accessible name carries its value and its unsaved / conflict state (QA-8), dialogs give
 * focus back through the store (QA-10), the grain badge follows the live grain (ARCH-L), and an
 * FY-total spread whose last month crosses zero is flagged (QA-15e).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
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
  return { ...render(<BudgetGrid {...props} />), props };
}

const rowIndex = (acct: string) => store.getLayout().rows.find(r => r.key === accountRowKey(acct))!.index;
const cell = (acct: string, c: number) => document.querySelector<HTMLElement>(`[data-pos="${rowIndex(acct)}:${c}"]`)!;
const FY = MONTHS.length;
const editor = () => screen.queryByRole('textbox', { name: /budget$/ });
/** fireEvent returns false when a handler called preventDefault. */
const keyPrevented = (el: HTMLElement, init: Record<string, unknown>) => !fireEvent.keyDown(el, init);

describe('QA-1: no keyboard trap', () => {
  it('Tab off the FY column calls onExit; preventDefault only when onExit moved focus', () => {
    const onExit = vi.fn(() => false);
    mount({ onExit });
    fireEvent.mouseDown(cell(ID.rev1, FY), { button: 0 });
    expect(keyPrevented(cell(ID.rev1, FY), { key: 'Tab' })).toBe(false); // native Tab moves on
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('when onExit moved focus the Tab is consumed', () => {
    mount({ onExit: vi.fn(() => true) });
    fireEvent.mouseDown(cell(ID.rev1, FY), { button: 0 });
    expect(keyPrevented(cell(ID.rev1, FY), { key: 'Tab' })).toBe(true);
  });

  it('a locked (clean) grid lets Tab leave from the FY column', () => {
    store.reset(gridModel(), { view: COMPANY, canWrite: true, locked: true });
    mount({ canWrite: false });
    fireEvent.mouseDown(cell(ID.rev2, FY), { button: 0 });
    expect(keyPrevented(cell(ID.rev2, FY), { key: 'Tab' })).toBe(false);
  });

  it('Shift+Tab at column 0 leaves the grid natively without calling onExit', () => {
    const onExit = vi.fn(() => true);
    mount({ onExit });
    fireEvent.mouseDown(cell(ID.rev2, 0), { button: 0 });
    expect(keyPrevented(cell(ID.rev2, 0), { key: 'Tab', shiftKey: true })).toBe(false);
    expect(onExit).not.toHaveBeenCalled();
  });

  it('Shift+Tab at column 0 while editing commits the draft and still leaves', () => {
    mount();
    fireEvent.mouseDown(cell(ID.rev2, 0), { button: 0 });
    fireEvent.keyDown(cell(ID.rev2, 0), { key: '4' });
    expect(keyPrevented(editor()!, { key: 'Tab', shiftKey: true })).toBe(false);
    expect(store.valueAt(key(ID.rev2, 0))).toBe(4_00);
    expect(editor()).toBeNull();
  });

  it('Tab inside the row still moves cell to cell (handled)', () => {
    mount();
    fireEvent.mouseDown(cell(ID.rev2, 0), { button: 0 });
    expect(keyPrevented(cell(ID.rev2, 0), { key: 'Tab' })).toBe(true);
    expect(document.activeElement).toBe(cell(ID.rev2, 1));
  });
});

describe('QA-4 / QA-5: the editor', () => {
  it('a refused typed amount keeps the editor open with its reason, and writes nothing', () => {
    mount();
    fireEvent.mouseDown(cell(ID.rev2, 2), { button: 0 });
    fireEvent.keyDown(cell(ID.rev2, 2), { key: '1' });
    fireEvent.change(editor()!, { target: { value: '1,234' } });
    fireEvent.keyDown(editor()!, { key: 'Enter' });
    expect(editor()).toHaveValue('1,234');
    expect(editor()).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent(/1,234|ambiguous|comma/i);
    expect(store.valueAt(key(ID.rev2, 2))).toBeNull();
    // Fixing the text and pressing Enter commits.
    fireEvent.change(editor()!, { target: { value: '1234' } });
    fireEvent.keyDown(editor()!, { key: 'Enter' });
    expect(store.valueAt(key(ID.rev2, 2))).toBe(1234_00);
    expect(editor()).toBeNull();
  });

  it('a double-click inside the open editor keeps the draft', () => {
    mount();
    fireEvent.doubleClick(cell(ID.rev1, 0));
    fireEvent.change(editor()!, { target: { value: '77' } });
    fireEvent.doubleClick(editor()!);
    expect(editor()).toHaveValue('77');
  });
});

describe('F4: the editor keeps its own tokens in dark', () => {
  it('border, fill and text are inline token styles, which the global dark input rules cannot override', () => {
    mount();
    fireEvent.doubleClick(cell(ID.rev1, 0));
    const el = editor()!;
    expect(el.style.borderColor).toBe('var(--ff-cell-focus-ring)');
    expect(el.style.backgroundColor).toBe('var(--ff-bg-primary)');
    expect(el.style.color).toBe('var(--ff-text-primary)');
  });
});

describe('QA-8: the accessible name carries value and state', () => {
  it('names the value, then "unsaved" for a dirty cell and "conflict" for a 409 conflict', () => {
    mount();
    expect(cell(ID.rev1, 0)).toHaveAccessibleName(/Mar 2026.*R 1 000\.00/);
    expect(cell(ID.rev2, 0)).toHaveAccessibleName(/not budgeted/);
    act(() => { store.apply([{ key: key(ID.rev2, 0), cents: 5_00 }]); });
    expect(cell(ID.rev2, 0)).toHaveAccessibleName(/R 5\.00, unsaved/);
    act(() => { store.reset(gridModel(), { view: COMPANY, canWrite: true, values: new Map([[key(ID.rev1, 0), 9_00]]), conflicts: [key(ID.rev1, 0)] }); });
    expect(cell(ID.rev1, 0)).toHaveAccessibleName(/R 9\.00, unsaved, conflict/);
  });
});

describe('QA-10: focus comes back through the store', () => {
  it('cancelling a row-action dialog focuses the row\'s cell and moves the roving tab stop there', async () => {
    mount();
    fireEvent.mouseDown(cell(ID.rev1, 4), { button: 0 });
    fireEvent.click(screen.getByRole('button', { name: 'Row actions for 1010 Account 1010' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Spread across months…' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(store.getGridState().focus).toEqual({ r: rowIndex(ID.rev2), c: 0 });
    expect(document.activeElement).toBe(cell(ID.rev2, 0));
    expect(cell(ID.rev2, 0).tabIndex).toBe(0);
    expect(cell(ID.rev1, 4).tabIndex).toBe(-1);
  });
});

describe('ARCH-L: the grain badge is live', () => {
  it('a first write in a CC1 view makes the account CC1 grain, and its badge says so', () => {
    const view = { kind: 'cc1', memberId: ID.m1 } as const;
    store.setView(view);
    mount({ view });
    const header = () => screen.getByRole('rowheader', { name: /^1010/ });
    expect(header()).not.toHaveTextContent('CC1');
    act(() => { store.apply([{ key: cellKey({ glAccountId: ID.rev2, cc1Id: ID.m1, cc2Id: null, buId: null, month: MONTHS[0]! }), cents: 1 }]); });
    expect(header()).toHaveTextContent('CC1');
  });
});

describe('QA-15e: an FY spread whose last month crosses zero is flagged', () => {
  it('R1 800 at R100 over 12 months: eleven × R200 and the last −R400, with a visible notice', () => {
    mount({ roundingUnit: 100 });
    fireEvent.mouseDown(cell(ID.rev2, FY), { button: 0 });
    fireEvent.keyDown(cell(ID.rev2, FY), { key: '1' });
    fireEvent.change(editor()!, { target: { value: '1800' } });
    fireEvent.keyDown(editor()!, { key: 'Enter' });
    expect(store.valueAt(key(ID.rev2, 11))).toBe(-400_00);
    expect(screen.getByRole('status')).toHaveTextContent(/last month.*below zero|crosses zero|smaller rounding unit/i);
  });
});

describe('notice list', () => {
  it('a cell entry names row, month and text; an entry with no cell (paste past the end) prints just its reason', () => {
    mount();
    act(() => {
      store.setNotice([
        { rowLabel: '1010 Account 1010', monthLabel: 'Mar 2026', raw: '1,234', reason: 'Ambiguous.' },
        { rowLabel: 'Past the end of the grid', monthLabel: '', raw: '', reason: '3 pasted cells fell past the end of the grid and were not pasted.' },
        { rowLabel: '1000 Account 1000', monthLabel: 'Apr 2026', raw: '', reason: 'Empty raw with a month.' },
      ]);
    });
    const items = within(screen.getByRole('status')).getAllByRole('listitem').map(li => li.textContent);
    expect(items).toEqual([
      '1010 Account 1010, Mar 2026: “1,234”: Ambiguous.',
      'Past the end of the grid: 3 pasted cells fell past the end of the grid and were not pasted.',
      '1000 Account 1000, Apr 2026: Empty raw with a month.',
    ]);
    expect(items.join('\n')).not.toMatch(/, :|“”/);
  });
});
