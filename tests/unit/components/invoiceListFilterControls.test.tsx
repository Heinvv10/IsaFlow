// The period control and the active-filter chips shared by the customer and
// supplier invoice lists.
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PeriodControl } from '@/components/accounting/PeriodControl';
import { ActiveFilterChips, periodChipLabel } from '@/components/accounting/ActiveFilterChips';

describe('PeriodControl', () => {
  it('a month deep link opens in month mode and a picked month emits the whole month', () => {
    const onChange = vi.fn();
    render(<PeriodControl from="2026-06-01" to="2026-06-30" onChange={onChange} inputClassName="" />);
    expect(screen.getByLabelText('Invoice date period')).toHaveProperty('value', 'month');
    expect(screen.getByLabelText('Invoice month')).toHaveProperty('value', '2026-06');

    fireEvent.change(screen.getByLabelText('Invoice month'), { target: { value: '2028-02' } });
    expect(onChange).toHaveBeenLastCalledWith('2028-02-01', '2028-02-29');
  });

  it('a partial range opens as a custom range with both bounds editable', () => {
    const onChange = vi.fn();
    render(<PeriodControl from="2026-06-02" to="2026-06-30" onChange={onChange} inputClassName="" />);
    expect(screen.getByLabelText('Invoice date period')).toHaveProperty('value', 'custom');
    fireEvent.change(screen.getByLabelText('Invoice date to'), { target: { value: '2026-07-15' } });
    expect(onChange).toHaveBeenLastCalledWith('2026-06-02', '2026-07-15');
  });

  it('"All dates" clears the range', () => {
    const onChange = vi.fn();
    render(<PeriodControl from="2026-06-01" to="2026-06-30" onChange={onChange} inputClassName="" />);
    fireEvent.change(screen.getByLabelText('Invoice date period'), { target: { value: 'all' } });
    expect(onChange).toHaveBeenLastCalledWith('', '');
  });
});

describe('ActiveFilterChips', () => {
  it('removes one filter per chip and clears all', () => {
    const removeCustomer = vi.fn();
    const clearAll = vi.fn();
    render(
      <ActiveFilterChips
        chips={[
          { key: 'customer', label: 'Customer: Herotel', onRemove: removeCustomer },
          { key: 'period', label: 'Jun 2026', onRemove: vi.fn() },
        ]}
        onClearAll={clearAll}
      />,
    );
    fireEvent.click(screen.getByLabelText('Remove filter: Customer: Herotel'));
    expect(removeCustomer).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText('Clear all'));
    expect(clearAll).toHaveBeenCalledTimes(1);
  });

  it('renders nothing when no filter is active', () => {
    const { container } = render(<ActiveFilterChips chips={[]} onClearAll={vi.fn()} />);
    expect(container.innerHTML).toBe('');
  });

  it('labels a whole month by name and a custom range by its bounds', () => {
    expect(periodChipLabel('2026-06-01', '2026-06-30', '2026-06')).toMatch(/Jun.*2026/);
    expect(periodChipLabel('2026-06-02', '', null)).toMatch(/^From 0?2 Jun.*2026$/);
  });
});
