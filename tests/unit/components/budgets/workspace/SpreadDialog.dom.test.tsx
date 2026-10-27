/**
 * SpreadDialog, row mode (spec §4.4 row actions): PY seasonality and step growth hand the grid
 * exactly PR-A's `spreadSeasonal` / `spreadStep` months as ONE write list; a seasonal spread with
 * no PY is refused with the reason and Apply stays disabled; a unit that pushes the last month
 * across zero is flagged in the preview (QA-15e).
 */
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { SpreadDialog, type SpreadTarget } from '@/components/accounting/budgets/workspace/SpreadDialog';
import { cellKey } from '@/modules/accounting/services/budgets/grid/cellKey';
import { spreadSeasonal, spreadStep } from '@/modules/accounting/services/budgets/grid/spread';
import { MONTHS } from './gridFixture';

const ACCT = 'a0000000-0000-4000-8000-0000000000aa';
const KEYS = MONTHS.map(month => cellKey({ glAccountId: ACCT, cc1Id: null, cc2Id: null, buId: null, month }));
const PY = [100_00, 200_00, 300_00, 100_00, 100_00, 100_00, 100_00, 100_00, 100_00, 100_00, 100_00, 400_00];

function open(py: number[] | null, unit: 1 | 100 | 1000 = 1) {
  const onApply = vi.fn();
  const target: SpreadTarget = { mode: 'row', label: '1010 Sales', row: { keys: KEYS, values: MONTHS.map(() => null) }, py };
  render(<SpreadDialog target={target} months={MONTHS} unit={unit} onApply={onApply} onClose={vi.fn()} />);
  const dialog = screen.getByRole('dialog');
  const amount = within(dialog).getByLabelText('Full-year amount');
  const setAmount = (text: string) => { fireEvent.change(amount, { target: { value: text } }); fireEvent.blur(amount); };
  const apply = () => within(dialog).getByRole('button', { name: 'Apply' });
  return { dialog, onApply, setAmount, apply };
}

const writesOf = (months: number[]) => KEYS.map((key, i) => ({ key, cents: months[i] }));

describe('SpreadDialog (row)', () => {
  it('PY seasonality writes spreadSeasonal\'s months, one list', () => {
    const { dialog, onApply, setAmount, apply } = open(PY, 100);
    setAmount('24000');
    fireEvent.click(within(dialog).getByRole('button', { name: 'PY seasonality' }));
    fireEvent.click(apply());
    const want = spreadSeasonal(24000_00, PY, 100);
    if (!want.ok) throw new Error(want.reason);
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply.mock.calls[0]![0]).toEqual(writesOf(want.months));
  });

  it('step growth writes spreadStep\'s months with the typed growth', () => {
    const { dialog, onApply, setAmount, apply } = open(null);
    setAmount('12000');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Step growth' }));
    fireEvent.change(within(dialog).getByLabelText('Monthly growth %'), { target: { value: '10' } });
    fireEvent.click(apply());
    const want = spreadStep(12000_00, 12, 10, 1);
    if (!want.ok) throw new Error(want.reason);
    expect(onApply.mock.calls[0]![0]).toEqual(writesOf(want.months));
    expect(want.months[11]!).toBeGreaterThan(want.months[0]!);
  });

  it('seasonality without PY: refused with the reason, Apply disabled', () => {
    const { dialog, setAmount, apply } = open(null);
    setAmount('1000');
    fireEvent.click(within(dialog).getByRole('button', { name: 'PY seasonality' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Prior-year actuals are not loaded.');
    expect(apply()).toBeDisabled();
  });

  it('flags a last month the unit pushed across zero (R1 800 at R100)', () => {
    const { dialog, setAmount } = open(null, 100);
    setAmount('1800');
    expect(within(dialog).getByText(/last month.*other side of zero/i)).toBeInTheDocument();
    setAmount('1200');
    expect(within(dialog).queryByText(/other side of zero/i)).toBeNull();
  });
});
