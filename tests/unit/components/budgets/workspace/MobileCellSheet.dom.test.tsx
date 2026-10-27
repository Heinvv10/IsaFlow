/**
 * The phone path (spec §12): with a coarse pointer / narrow viewport (`matchMedia` stub) a tap on a
 * cell opens MobileCellSheet instead of the keyboard editor; Save cell commits through the store
 * (one undo entry), Next month saves and moves along the row, the FY column spreads evenly with the
 * rounding unit, a read-only cell shows its reason with no Save, and the row's actions are offered.
 * On a fine pointer no sheet opens (useCompact false).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { BudgetGrid, type BudgetGridProps } from '@/components/accounting/budgets/workspace/BudgetGrid';
import { GridStore, accountRowKey, rollupRowKey } from '@/components/accounting/budgets/workspace/gridStore';
import { cellKey } from '@/modules/accounting/services/budgets/grid/cellKey';
import { ID, MONTHS, gridModel } from './gridFixture';

const COMPANY = { kind: 'company' } as const;
const key = (acct: string, m: number) => cellKey({ glAccountId: acct, cc1Id: null, cc2Id: null, buId: null, month: MONTHS[m]! });

let store: GridStore;
let compact = true;
beforeEach(() => {
  compact = true;
  vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
    matches: compact, media: query, onchange: null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
  })));
  store = new GridStore();
  store.reset(gridModel(), { view: COMPANY, canWrite: true });
});
afterEach(() => { vi.unstubAllGlobals(); });

function mount(over: Partial<BudgetGridProps> = {}) {
  const props: BudgetGridProps = {
    store, view: COMPANY, roundingUnit: 1, density: 'owner', showPy: true, compareLabel: null,
    canWrite: true, members: [], onSave: vi.fn(), onExit: vi.fn(() => false), ...over,
  };
  return render(<BudgetGrid {...props} />);
}
const rowIndex = (rowKey: string) => store.getLayout().rows.find(r => r.key === rowKey)!.index;
const tap = (rowKey: string, c: number) =>
  fireEvent.mouseDown(document.querySelector<HTMLElement>(`[data-pos="${rowIndex(rowKey)}:${c}"]`)!, { button: 0 });
const sheet = () => screen.getByRole('dialog');
const typeAmount = (text: string) => {
  const input = within(sheet()).getByLabelText('Budget');
  fireEvent.change(input, { target: { value: text } });
  fireEvent.blur(input);
};

describe('MobileCellSheet via the grid', () => {
  it('a tap opens the sheet naming account and month; Save cell writes one undo entry', () => {
    mount();
    tap(accountRowKey(ID.rev2), 2);
    expect(sheet()).toHaveAccessibleName('1010 Account 1010, May 2026 budget');
    expect(screen.queryByRole('textbox', { name: /May 2026 budget$/ })).toBeNull(); // not the desktop editor
    typeAmount('450');
    fireEvent.click(within(sheet()).getByRole('button', { name: 'Save cell' }));
    expect(store.valueAt(key(ID.rev2, 2))).toBe(450_00);
    expect(screen.queryByRole('dialog')).toBeNull();
    act(() => { store.undo(); });
    expect(store.valueAt(key(ID.rev2, 2))).toBeNull();
  });

  it('Next month saves, then shows the next month of the same row', () => {
    mount();
    tap(accountRowKey(ID.rev2), 0);
    typeAmount('10');
    fireEvent.click(within(sheet()).getByRole('button', { name: 'Next month' }));
    expect(store.valueAt(key(ID.rev2, 0))).toBe(10_00);
    expect(sheet()).toHaveAccessibleName('1010 Account 1010, Apr 2026 budget');
  });

  it('the FY column spreads evenly with the rounding unit', () => {
    mount({ roundingUnit: 100 });
    tap(accountRowKey(ID.rev2), MONTHS.length);
    typeAmount('1200');
    fireEvent.click(within(sheet()).getByRole('button', { name: 'Save cell' }));
    expect(store.getRow(accountRowKey(ID.rev2)).values.every(v => v === 100_00)).toBe(true);
  });

  it('a read-only cell shows its reason and no Save', () => {
    mount();
    tap(rollupRowKey(ID.hdr), 0);
    expect(within(sheet()).getByRole('status')).toHaveTextContent('Sub-account roll-up');
    expect(within(sheet()).queryByRole('button', { name: 'Save cell' })).toBeNull();
  });

  it('offers the row\'s actions and runs them from the sheet', async () => {
    mount();
    tap(accountRowKey(ID.rev1), 0);
    fireEvent.click(within(sheet()).getByRole('button', { name: 'Clear row' }));
    expect(store.getRow(accountRowKey(ID.rev1)).values.every(v => v === null)).toBe(true);
  });

  it('on a fine pointer a press focuses the cell and opens no sheet', () => {
    compact = false;
    mount();
    tap(accountRowKey(ID.rev2), 2);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(document.querySelector(`[data-pos="${rowIndex(accountRowKey(ID.rev2))}:2"]`));
  });
});
