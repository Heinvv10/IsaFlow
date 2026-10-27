/**
 * Spec §13 / §14 render-count gate: committing one cell renders exactly ONE line row, its band
 * subtotal, and the GP / OP / NP rows (each once), counted by React Profiler over a grid built on
 * the store's public row / total hooks. Mutation that must turn it red: a grid-level subscription
 * (every row snapshot replaced and notified on every write).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';
import { GridStore, accountRowKey } from '@/components/accounting/budgets/workspace/gridStore';
import { commitDraft } from '@/components/accounting/budgets/workspace/gridCommands';
import { GridHarness } from './GridHarness';
import { ID, gridModel } from './gridFixture';

let store: GridStore;
let rendered: string[];
beforeEach(() => {
  store = new GridStore();
  store.reset(gridModel(), { view: { kind: 'company' }, canWrite: true });
  rendered = [];
});
const rowIndex = (acct: string) => store.getLayout().rows.find(r => r.key === accountRowKey(acct))!.index;

function mount() {
  const view = render(<GridHarness store={store} onRender={id => { rendered.push(id); }} />);
  rendered.length = 0;
  return view;
}

describe('BudgetGrid render count', () => {
  it('committing one turnover cell renders its row once, Total Turnover, GP, OP and NP once each', () => {
    mount();
    act(() => { commitDraft(store, { r: rowIndex(ID.rev2), c: 3 }, '500', false, 1); });
    expect([...rendered].sort()).toEqual([
      accountRowKey(ID.rev2), 'profit:grossProfit', 'profit:netProfit', 'profit:operatingProfit', 'total:turnover',
    ]);
  });

  it('an operating-expense cell renders its row, its header roll-up, Total Operating Expenses, OP and NP', () => {
    mount();
    act(() => { commitDraft(store, { r: rowIndex(ID.kid2), c: 0 }, '9', false, 1); });
    expect([...rendered].sort()).toEqual([
      accountRowKey(ID.kid2), 'profit:netProfit', 'profit:operatingProfit', 'rollup:' + ID.hdr, 'total:operating_expense',
    ]);
  });

  it('through the keyboard (type, Tab commits): no other line row renders', () => {
    const { container } = mount();
    const cell = container.querySelector<HTMLElement>(`[data-pos="${rowIndex(ID.rev2)}:3"]`)!;
    act(() => { fireEvent.mouseDown(cell); });
    rendered.length = 0;
    fireEvent.keyDown(cell, { key: '7' });
    const input = container.querySelector<HTMLInputElement>('input[aria-label="cell editor"]')!;
    fireEvent.change(input, { target: { value: '75' } });
    fireEvent.keyDown(input, { key: 'Tab' });
    expect(store.getRow(accountRowKey(ID.rev2)).values[3]).toBe(7500);
    expect(new Set(rendered)).toEqual(new Set([
      accountRowKey(ID.rev2), 'total:turnover', 'profit:grossProfit', 'profit:operatingProfit', 'profit:netProfit',
    ]));
  });
});
