/** F2: list/period filter dates are typed DateFields. Valid text commits ISO on blur; refused text never reaches the filter state. */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PeriodControl } from '@/components/accounting/PeriodControl';
import { BankTxFilters, type BankTxFiltersProps } from '@/components/accounting/bank-transactions/BankTxFilters';
import { VAT201PeriodSelector } from '@/components/accounting/sars/VAT201PeriodSelector';
import { typeDate } from '../helpers/dateFields';

describe('PeriodControl custom range', () => {
  it('"1 Oct 2026" + blur commits 2026-10-01; the other bound is untouched', () => {
    const onChange = vi.fn();
    render(<PeriodControl from="2026-06-02" to="2026-06-30" onChange={onChange} inputClassName="" />);
    typeDate(screen.getByLabelText('Invoice date to'), '1 Oct 2026');
    expect(onChange).toHaveBeenLastCalledWith('2026-06-02', '2026-10-01');
  });

  it('unreadable text is refused and never reaches the filter', () => {
    const onChange = vi.fn();
    render(<PeriodControl from="2026-06-02" to="2026-06-30" onChange={onChange} inputClassName="" />);
    typeDate(screen.getByLabelText('Invoice date from'), 'zz');
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toBeTruthy();
  });

  it('clearing the text clears that bound', () => {
    const onChange = vi.fn();
    render(<PeriodControl from="2026-06-02" to="2026-06-30" onChange={onChange} inputClassName="" />);
    typeDate(screen.getByLabelText('Invoice date to'), '');
    expect(onChange).toHaveBeenLastCalledWith('2026-06-02', '');
  });
});

describe('BankTxFilters date range', () => {
  const noop = vi.fn();
  const props = {
    tab: 'new', page: 1, total: 0, pageSize: 25, selectedCount: 0, selectedBank: 'b1', smartRunning: false,
    showCC: false, showBU: false, showBatchEdit: false, searchTerm: '', fromDate: '', toDate: '',
    fromAmount: '', toAmount: '', sortOrder: 'desc', allocationFilter: 'all', txType: 'all', allocType: 'all', hasSuggestion: 'all',
    onRefresh: noop, onBulkAccept: noop, onBatchAccept: noop, onBatchDelete: noop, onToggleBatchEdit: noop, onExport: noop,
    onApplyRules: noop, onDownloadReport: noop, onSearchChange: noop, onFromDateChange: noop, onToDateChange: noop,
    onFromAmountChange: noop, onToAmountChange: noop, onSortOrderChange: noop, onAllocationFilterChange: noop,
    onTxTypeChange: noop, onAllocTypeChange: noop, onHasSuggestionChange: noop, onToggleCC: noop, onToggleBU: noop,
  } satisfies BankTxFiltersProps;

  it('typed text commits as ISO; invalid text does not fetch', () => {
    const onFromDateChange = vi.fn();
    render(<BankTxFilters {...props} onFromDateChange={onFromDateChange} />);
    typeDate(screen.getByLabelText('From date'), '1 Oct 2026');
    expect(onFromDateChange).toHaveBeenCalledTimes(1);
    expect(onFromDateChange).toHaveBeenLastCalledWith('2026-10-01');
    typeDate(screen.getByLabelText('From date'), 'zz');
    expect(onFromDateChange).toHaveBeenCalledTimes(1);
  });
});

describe('VAT201PeriodSelector', () => {
  it('typed period dates commit ISO; unreadable text never reaches the period', () => {
    const onFromChange = vi.fn();
    const onToChange = vi.fn();
    render(
      <VAT201PeriodSelector
        from="2026-09-01" to="2026-10-31" onFromChange={onFromChange} onToChange={onToChange}
        onGenerate={vi.fn()} onQuickSelect={vi.fn()} loading={false}
        vatPeriod="monthly" alignment="odd" quickPeriods={[]}
      />,
    );
    typeDate(screen.getByLabelText(/^Period Start/), '2 Sep 2026');
    expect(onFromChange).toHaveBeenLastCalledWith('2026-09-02');
    typeDate(screen.getByLabelText(/^Period End/), 'zz');
    expect(onToChange).not.toHaveBeenCalled();
    typeDate(screen.getByLabelText(/^Period End/), '30 Nov 2026');
    expect(onToChange).toHaveBeenLastCalledWith('2026-11-30');
  });
});

describe('PeriodControl range hints', () => {
  it('a From after To is refused and never reaches the filter', () => {
    const onChange = vi.fn();
    render(<PeriodControl from="2026-06-02" to="2026-06-30" onChange={onChange} inputClassName="" />);
    typeDate(screen.getByLabelText('Invoice date from'), '15 Jul 2026');
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toMatch(/on or before/);
  });

  it('a To before From is refused', () => {
    const onChange = vi.fn();
    render(<PeriodControl from="2026-06-02" to="2026-06-30" onChange={onChange} inputClassName="" />);
    typeDate(screen.getByLabelText('Invoice date to'), '1 May 2026');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('a garbage bound from the URL does not crash the control', () => {
    render(<PeriodControl from="2026-06-02" to="not-a-date" onChange={vi.fn()} inputClassName="" />);
    expect(screen.getByLabelText('Invoice date from')).toBeTruthy();
  });
});

describe('PeriodControl impossible bound', () => {
  it('an impossible date from the URL (2026-02-31) does not crash the control or become a bound', () => {
    const onChange = vi.fn();
    render(<PeriodControl from="2026-02-31" to="2026-06-30" onChange={onChange} inputClassName="" />);
    typeDate(screen.getByLabelText('Invoice date to'), '1 Jan 2026');
    expect(onChange).toHaveBeenLastCalledWith('2026-02-31', '2026-01-01'); // no minDate was applied from the bad value
  });
});
