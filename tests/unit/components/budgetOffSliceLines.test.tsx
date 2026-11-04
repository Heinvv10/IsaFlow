/**
 * Budgets P5-2b (Hein, 2026-11-04): a line outside every budgeted slice of a budgeted account. The lines table labels
 * it "Not in a budgeted slice" (cards and table), distinct from "No budget"; the approve dialog treats it as it treats
 * an over line: a reason in warn, refused in block unless an owner/admin overrides.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { BudgetLinesTable } from '@/components/accounting/ap/BudgetLinesTable';
import type { BudgetCheckLine } from '@/modules/accounting/services/budgets/budgetCheckTypes';

const role = vi.hoisted(() => ({ current: 'owner' }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: role.current }) }));
import { BudgetApproveDialog } from '@/components/accounting/ap/BudgetApproveDialog';

const line = (o: Partial<BudgetCheckLine>): BudgetCheckLine => ({
  glAccountId: 'a', month: '2026-11', grain: 'cc1', cc1Id: null, cc2Id: null, buId: null, unassigned: true,
  budget: null, actual: 0, committed: 0, remaining: null, amount: 300, over: false, offSlice: true,
  accountLabel: '5200 Labour Costs', sliceLabel: '', ...o,
});
const noBudget = line({ glAccountId: 'n', grain: null, unassigned: false, offSlice: false, accountLabel: '6300 Unbudgeted', amount: 10 });

afterEach(() => { cleanup(); role.current = 'owner'; });

describe('BudgetLinesTable: off-slice lines', () => {
  it('labels an off-slice line "Not in a budgeted slice" in the cards and the table; a no-budget line stays "No budget"', () => {
    render(<BudgetLinesTable lines={[line({}), noBudget]} />);
    for (const id of ['budget-lines-cards', 'budget-lines-table']) {
      const root = screen.getByTestId(id);
      expect(within(root).getAllByText('Not in a budgeted slice'), id).toHaveLength(1);
      expect(within(root).getAllByText('No budget'), id).toHaveLength(1);
      expect(within(root).getAllByText('(not in a budgeted slice)'), id).toHaveLength(1);
    }
    expect(screen.getByText('5200 Labour Costs · Unassigned · 2026-11')).toBeTruthy();
  });
});

const dialog = (policy: 'warn' | 'block', onApprove = vi.fn()) => {
  render(<BudgetApproveDialog open policy={policy} lines={[line({}), noBudget]} error="" busy={false} onCancel={() => undefined} onApprove={onApprove} />);
  return onApprove;
};

describe('BudgetApproveDialog: off-slice lines', () => {
  it('warn: says the line is not in a budgeted slice and approves only with a reason', () => {
    const onApprove = dialog('warn');
    expect(screen.getByText(/One line is not in a budgeted slice/)).toBeTruthy();
    const approve = screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Shared cost' } });
    expect(approve.disabled).toBe(false);
    fireEvent.click(approve);
    expect(onApprove).toHaveBeenCalledWith({ budgetReason: 'Shared cost' });
  });

  it('block: a manager cannot approve; an owner overrides with a reason', () => {
    role.current = 'manager';
    dialog('block');
    expect((screen.getByRole('button', { name: 'Override and approve' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.getByText(/Only an owner or admin can override it/)).toBeTruthy();
    cleanup();
    role.current = 'owner';
    const onApprove = dialog('block');
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Board' } });
    fireEvent.click(screen.getByRole('button', { name: 'Override and approve' }));
    expect(onApprove).toHaveBeenCalledWith({ budgetReason: 'Board', budgetOverride: true });
  });
});
