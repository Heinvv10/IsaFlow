import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { ComparatorControls } from '@/components/accounting/reportControls/ComparatorControls';
import type { StatementColumns } from '@/modules/accounting/services/reports/statementRows/statementModel';

afterEach(cleanup);
const OFF: StatementColumns = { prior: false, budget: false, variance: false, trend: false };

describe('ComparatorControls', () => {
  it('turns a comparator on without touching the others', () => {
    const onChange = vi.fn();
    render(<ComparatorControls value={OFF} onChange={onChange} />);
    fireEvent.click(screen.getByLabelText('Budget'));
    expect(onChange).toHaveBeenCalledWith({ ...OFF, budget: true });
  });

  it('turns variance off when the last comparator is turned off', () => {
    const onChange = vi.fn();
    render(<ComparatorControls value={{ prior: true, budget: false, variance: true, trend: false }} onChange={onChange} />);
    fireEvent.click(screen.getByLabelText('Prior period'));
    expect(onChange).toHaveBeenCalledWith({ prior: false, budget: false, variance: false, trend: false });
  });

  it('disables variance while no comparator is on', () => {
    render(<ComparatorControls value={OFF} onChange={vi.fn()} />);
    expect((screen.getByLabelText('Variance') as HTMLInputElement).disabled).toBe(true);
  });

  it('disables the company-wide trend when the surface says it is unavailable; the budget follows the filter', () => {
    // The trend series is not filtered by dimension, so a filtered statement
    // must not be able to switch it on. The budget is (budgets P3 PR-C).
    render(<ComparatorControls value={OFF} onChange={vi.fn()} companyWideUnavailable />);
    expect((screen.getByLabelText('12-month trend') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText('Budget') as HTMLInputElement).disabled).toBe(false);
    // Prior period IS filtered with the statement, so it stays available.
    expect((screen.getByLabelText('Prior period') as HTMLInputElement).disabled).toBe(false);
  });

  it('offers the trend column independently of any comparator', () => {
    const onChange = vi.fn();
    render(<ComparatorControls value={OFF} onChange={onChange} />);
    fireEvent.click(screen.getByLabelText('12-month trend'));
    expect(onChange).toHaveBeenCalledWith({ ...OFF, trend: true });
  });
});
