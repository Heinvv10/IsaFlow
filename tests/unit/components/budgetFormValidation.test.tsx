/**
 * BudgetForm's amounts are kit MoneyFields: each is parsed on blur (or Enter) into cents. The annual
 * amount spreads over the months when it is committed, a month edit resets the annual amount to the
 * sum, and text the field refuses blocks the save instead of being saved as 0. An empty month is 0.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { BudgetForm } from '@/components/accounting/budgets/BudgetForm';
import { formatCents } from '@/lib/money/formatMoney';

afterEach(cleanup);

const KEYS = ['2026-03', '2026-04'];
const KEYS_14 = ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07',
  '2026-08', '2026-09', '2026-10', '2026-11', '2026-12', '2027-01', '2027-02'];
const ACCOUNTS = [{ id: 'g1', accountCode: '5000', accountName: 'Rent' }];
/** What a field shows for `cents` once committed. */
const shown = (cents: number) => formatCents(cents, { symbol: false });

const annual = () => screen.getByLabelText(/Annual amount/) as HTMLInputElement;
/** The month's MoneyField input; `budget-month-<key>` wraps the field. */
const month = (key: string) => within(screen.getByTestId(`budget-month-${key}`)).getByRole('textbox') as HTMLInputElement;
/** Type `text` into a field and leave it, as a user does. */
function enter(el: HTMLInputElement, text: string) {
  fireEvent.focus(el);
  fireEvent.change(el, { target: { value: text } });
  fireEvent.blur(el);
}
const formError = () => screen.queryByTestId('budget-error');

function open(keys = KEYS, amount = '100') {
  const onSubmit = vi.fn();
  render(<BudgetForm fiscalYear={2027} monthKeys={keys} accounts={ACCOUNTS} busy={false} onSubmit={onSubmit} onCancel={vi.fn()} />);
  fireEvent.change(screen.getByText('Select GL Account *').closest('select')!, { target: { value: 'g1' } });
  enter(annual(), amount);
  return onSubmit;
}
const submit = () => fireEvent.submit(screen.getByTestId('budget-save').closest('form')!);

describe('BudgetForm amounts', () => {
  it('its hint text is not in the tertiary colour (about 2.4:1 on the light theme)', () => {
    open();
    expect(screen.getByText(/A month left empty is saved as 0/).className).not.toContain('ff-text-tertiary');
  });

  it('the annual amount spreads over the months on blur, not while typing; cents go on the last month', () => {
    open(KEYS, '');
    fireEvent.change(annual(), { target: { value: '100.01' } });
    expect(KEYS.map(k => month(k).value)).toEqual(['', '']);
    fireEvent.blur(annual());
    expect(KEYS.map(k => month(k).value)).toEqual([shown(5001), shown(5000)]);
  });

  it('Enter in the annual amount spreads it too', () => {
    open(KEYS, '');
    fireEvent.change(annual(), { target: { value: '300' } });
    fireEvent.keyDown(annual(), { key: 'Enter' });
    expect(KEYS.map(k => month(k).value)).toEqual([shown(15000), shown(15000)]);
  });

  it('a month edit resets the annual amount to the sum, and that is what is saved', () => {
    const onSubmit = open();
    enter(month('2026-04'), '75.25');
    expect(annual().value).toBe(shown(12525));
    submit();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0]![0]).toMatchObject({
      glAccountId: 'g1', annualAmount: 125.25, months: [{ month: '2026-03', amount: 50 }, { month: '2026-04', amount: 75.25 }],
    });
  });

  it('a 14-month year shows 14 month fields, and 14 000 spreads as 1 000 each', () => {
    const onSubmit = open(KEYS_14, '14000');
    expect(screen.getAllByTestId(/^budget-month-/)).toHaveLength(14);
    expect(KEYS_14.map(k => month(k).value)).toEqual(Array(14).fill(shown(100000)));
    submit();
    expect(onSubmit.mock.calls[0]![0].months).toEqual(KEYS_14.map(m => ({ month: m, amount: 1000 })));
  });

  it('a 14-month year keeps the cents exact: 1 000 is 71.43 x 13 and 71.41 on the last', () => {
    const onSubmit = open(KEYS_14, '1000');
    submit();
    const months = onSubmit.mock.calls[0]![0].months as { amount: number }[];
    expect(months.slice(0, 13).every(m => m.amount === 71.43)).toBe(true);
    expect(months[13]!.amount).toBe(71.41);
    expect(onSubmit.mock.calls[0]![0].annualAmount).toBe(1000);
  });

  it('a month the field refuses ("1,234") blocks the save and names the month', () => {
    const onSubmit = open();
    enter(month('2026-04'), '1,234');
    expect(screen.getByText(/ambiguous/)).toBeTruthy();
    submit();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(formError()?.textContent).toMatch(/Apr 2026/);
  });

  it('a refused month leaves the annual amount as it was', () => {
    open();
    enter(month('2026-04'), '1,234');
    expect(annual().value).toBe(shown(10000));
  });

  it('a refused annual amount blocks the save', () => {
    const onSubmit = open(KEYS, '1,234');
    submit();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(formError()?.textContent).toMatch(/annual amount/i);
  });

  it('an empty annual amount blocks the save', () => {
    const onSubmit = open(KEYS, '');
    submit();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(formError()?.textContent).toMatch(/annual amount/i);
  });

  it('an empty month is saved as 0', () => {
    const onSubmit = open();
    enter(month('2026-04'), '');
    submit();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0]![0].months).toEqual([{ month: '2026-03', amount: 50 }, { month: '2026-04', amount: 0 }]);
    expect(formError()).toBeNull();
  });

  it('the error clears when the amount is corrected', () => {
    const onSubmit = open();
    enter(month('2026-04'), '1,234');
    submit();
    expect(formError()).not.toBeNull();
    enter(month('2026-04'), '25');
    expect(formError()).toBeNull();
    submit();
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('a new annual amount replaces refused month text and lets the save through', () => {
    const onSubmit = open();
    enter(month('2026-04'), '1,234');
    enter(annual(), '200');
    expect(KEYS.map(k => month(k).value)).toEqual([shown(10000), shown(10000)]);
    submit();
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('Enter in the annual amount commits it before the form submits', () => {
    const onSubmit = open(KEYS, '');
    fireEvent.change(annual(), { target: { value: '300' } });
    fireEvent.keyDown(annual(), { key: 'Enter' });
    submit();
    expect(onSubmit.mock.calls[0]![0]).toMatchObject({ annualAmount: 300, months: [{ amount: 150 }, { amount: 150 }] });
  });

  it('clicking Save commits the month being typed in (the click blurs it) and saves its amount', () => {
    const onSubmit = open();
    fireEvent.change(month('2026-04'), { target: { value: '80' } });
    fireEvent.blur(month('2026-04'));
    fireEvent.click(screen.getByTestId('budget-save'));
    expect(onSubmit.mock.calls[0]![0]).toMatchObject({ annualAmount: 130, months: [{ amount: 50 }, { amount: 80 }] });
  });

  it('negative amounts are accepted (a budget may be negative) and spread with the cents on the last month', () => {
    const onSubmit = open(KEYS, '-100.01');
    expect(screen.queryByRole('alert')).toBeNull();
    submit();
    expect(onSubmit.mock.calls[0]![0]).toMatchObject({
      annualAmount: -100.01, months: [{ amount: -50.01 }, { amount: -50 }],
    });
  });

  it('a valid month edit replaces a refused annual amount with the sum, and the save goes through', () => {
    const onSubmit = open(KEYS, '1,234');
    enter(month('2026-04'), '10');
    expect(annual().value).toBe(shown(1000));
    expect(screen.queryByText(/ambiguous/)).toBeNull();
    submit();
    expect(onSubmit.mock.calls[0]![0]).toMatchObject({ annualAmount: 10, months: [{ amount: 0 }, { amount: 10 }] });
  });

  it('edit starts from the stored amounts', () => {
    render(<BudgetForm fiscalYear={2027} monthKeys={KEYS} accounts={ACCOUNTS} busy={false} onSubmit={vi.fn()} onCancel={vi.fn()}
      editing={{ glAccountId: 'g1', months: [{ month: '2026-03', amount: 10.1 }, { month: '2026-04', amount: 0.2 }] }} />);
    expect(KEYS.map(k => month(k).value)).toEqual([shown(1010), shown(20)]);
    expect(annual().value).toBe(shown(1030));
  });
});
