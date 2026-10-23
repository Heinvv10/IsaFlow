/** BudgetForm refuses an amount that is not a number instead of saving it as 0; only an empty month is 0. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { BudgetForm } from '@/components/accounting/budgets/BudgetForm';

afterEach(cleanup);

const KEYS = ['2026-03', '2026-04'];
const ACCOUNTS = [{ id: 'g1', accountCode: '5000', accountName: 'Rent' }];

function open() {
  const onSubmit = vi.fn();
  render(<BudgetForm fiscalYear={2027} monthKeys={KEYS} accounts={ACCOUNTS} busy={false} onSubmit={onSubmit} onCancel={vi.fn()} />);
  fireEvent.change(screen.getByText('Select GL Account *').closest('select')!, { target: { value: 'g1' } });
  fireEvent.change(screen.getByPlaceholderText('Annual Amount *'), { target: { value: '100' } });
  return onSubmit;
}
const submit = () => fireEvent.submit(screen.getByTestId('budget-save').closest('form')!);

describe('BudgetForm amounts', () => {
  it('a month that is not a finite number blocks the save and names the month', () => {
    const onSubmit = open();
    fireEvent.change(screen.getByTestId('budget-month-2026-04'), { target: { value: '1e999' } });
    submit();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toMatch(/Apr 2026/);
  });

  it('an empty month is saved as 0', () => {
    const onSubmit = open();
    fireEvent.change(screen.getByTestId('budget-month-2026-04'), { target: { value: '' } });
    submit();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0]![0].months).toEqual([{ month: '2026-03', amount: 50 }, { month: '2026-04', amount: 0 }]);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('the error clears when the amount is corrected', () => {
    const onSubmit = open();
    fireEvent.change(screen.getByTestId('budget-month-2026-04'), { target: { value: '1e999' } });
    submit();
    fireEvent.change(screen.getByTestId('budget-month-2026-04'), { target: { value: '25' } });
    expect(screen.queryByRole('alert')).toBeNull();
    submit();
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});
