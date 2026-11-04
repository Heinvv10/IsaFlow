/**
 * Budgets P5-2 (review round 5, browser proof at 390 px): the approve dialog's budget lines render as stacked
 * cards below `sm` (account · slice · month, then label-value rows) and as a table from `sm` up, both in the
 * DOM (CSS picks one). The over marker: "This bill" takes the unfavourable colour on an over line; Remaining
 * only when it is negative.
 */
import { describe, it, expect, afterEach } from 'vitest';
import React from 'react';
import { cleanup, render, screen, within } from '@testing-library/react';
import { BudgetLinesTable } from '@/components/accounting/ap/BudgetLinesTable';
import type { BudgetCheckLine } from '@/modules/accounting/services/budgets/budgetCheckTypes';
import { formatCurrency } from '@/utils/formatters';

const line = (o: Partial<BudgetCheckLine>): BudgetCheckLine => ({
  glAccountId: 'a', month: '2026-11', grain: 'cc1', cc1Id: 's', cc2Id: null, buId: null, unassigned: false,
  budget: 20000, actual: 0, committed: 0, remaining: 20000, amount: 25000, over: true,
  accountLabel: '5200 Labour Costs', sliceLabel: 'SALES Sales', ...o,
});
const coloured = (el: HTMLElement) => el.style.color !== '';

afterEach(cleanup);

describe('BudgetLinesTable', () => {
  it('cards below sm and a table from sm up, each line in both', () => {
    render(<BudgetLinesTable lines={[line({}), line({ glAccountId: 'b', accountLabel: '6300 Unbudgeted', budget: null, remaining: null, over: false, amount: 10 })]} />);
    const cards = screen.getByTestId('budget-lines-cards');
    const table = screen.getByTestId('budget-lines-table');
    expect(cards.className).toMatch(/\bsm:hidden\b/);
    expect(table.className).toMatch(/\bhidden\b/);
    expect(table.className).toMatch(/\bsm:block\b/);
    expect(within(cards).getAllByRole('listitem')).toHaveLength(2);
    expect(within(cards).getByText('5200 Labour Costs · SALES Sales · 2026-11')).toBeTruthy();
    for (const label of ['Budget', 'Actual', 'Committed', 'Remaining', 'This bill']) expect(within(cards).getAllByText(label).length).toBeGreaterThan(0);
    expect(within(cards).getByText('No budget')).toBeTruthy();
    expect(within(table).getByRole('table')).toBeTruthy();
  });

  it('over with a positive remaining: "This bill" coloured, Remaining not; a negative remaining is coloured', () => {
    render(<BudgetLinesTable lines={[line({}), line({ glAccountId: 'n', remaining: -500, actual: 20500 })]} />);
    for (const id of ['budget-lines-cards', 'budget-lines-table']) {
      const root = screen.getByTestId(id);
      // By exact textContent: the figures carry non-breaking spaces (formatMoney).
      const withText = (sel: string, t: string) => [...root.querySelectorAll<HTMLElement>(sel)].filter((e) => e.textContent === t);
      const bills = withText('span', formatCurrency(25000));
      expect(bills, `${id}: this bill`).toHaveLength(2);
      expect(bills.every(coloured), `${id}: this bill coloured`).toBe(true);
      expect(withText('[data-cell="remaining"]', formatCurrency(20000)).map(coloured), `${id}: positive remaining`).toEqual([false]);
      expect(withText('[data-cell="remaining"]', formatCurrency(-500)).map(coloured), `${id}: negative remaining`).toEqual([true]);
      expect(within(root).getAllByText('(over budget)').length).toBe(2); // the row's over marker
    }
  });
});
