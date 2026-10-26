/**
 * BudgetBulletRow draws only BUDGETED lines (buildBudgetBulletOption), so it
 * gates on the budgeted count: a payload of unbudgeted lines only says there is
 * no budget, rather than drawing an empty chart (budgets P0).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { BudgetBulletRow } from '@/components/accounting/charts/BudgetBulletRow';
import { buildBudgetVsActualLines } from '@/modules/accounting/services/reports/budgetVsActualLines';

afterEach(cleanup);

const RAW = [
  { id: 'a', account_code: '4000', account_name: 'Sales', account_type: 'revenue', actual_amount: 900 },
  { id: 'b', account_code: '6000', account_name: 'Rent', account_type: 'expense', actual_amount: 500 },
];
const UNAVAILABLE = 'No account carries a budget for this period.';

describe('BudgetBulletRow budgeted gate', () => {
  it('unbudgeted lines only: says there is no budget, draws no chart', () => {
    const { container } = render(<BudgetBulletRow lines={buildBudgetVsActualLines(RAW, {})} />);
    expect(container.textContent).toContain(UNAVAILABLE);
  });

  it('one budgeted line among unbudgeted ones: draws the chart', () => {
    const { container } = render(<BudgetBulletRow lines={buildBudgetVsActualLines(RAW, { a: 1000 })} />);
    expect(container.textContent).not.toContain(UNAVAILABLE);
  });
});
