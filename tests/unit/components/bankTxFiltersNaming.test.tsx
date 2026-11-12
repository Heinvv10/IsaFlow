/**
 * The bank transactions toolbar: every select and input has an accessible name. Its five selects showed only
 * their current option ("All Status"), which axe reports as select-name; Min R / Max R were bare spans.
 */
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render, screen, within, fireEvent } from '@testing-library/react';
import { BankTxFilters, type BankTxFiltersProps } from '@/components/accounting/bank-transactions/BankTxFilters';

const noop = vi.fn();
const props = {
  tab: 'new', page: 1, total: 0, pageSize: 25, selectedCount: 0, selectedBank: 'b1', smartRunning: false,
  showCC: false, showBU: false, showBatchEdit: false, searchTerm: '', fromDate: '', toDate: '',
  fromAmount: '', toAmount: '', sortOrder: 'desc', allocationFilter: 'all', txType: 'all', allocType: 'all', hasSuggestion: 'all', reconFilter: 'all',
  onRefresh: noop, onBulkAccept: noop, onBatchAccept: noop, onBatchDelete: noop, onToggleBatchEdit: noop, onExport: noop,
  onApplyRules: noop, onDownloadReport: noop, onSearchChange: noop, onFromDateChange: noop, onToDateChange: noop,
  onFromAmountChange: noop, onToAmountChange: noop, onSortOrderChange: noop, onAllocationFilterChange: noop,
  onTxTypeChange: noop, onAllocTypeChange: noop, onHasSuggestionChange: noop, onReconFilterChange: noop, onToggleCC: noop, onToggleBU: noop,
} satisfies BankTxFiltersProps;

describe('BankTxFilters: named controls', () => {
  it.each(['new', 'reviewed'] as const)('every select, input and button on the %s tab has a name', (tab) => {
    const { container } = render(<BankTxFilters {...props} tab={tab} />);
    const controls = ['combobox', 'textbox', 'spinbutton', 'button', 'link'].flatMap(r => within(container).queryAllByRole(r));
    expect(controls.length).toBeGreaterThan(10);
    for (const el of controls) expect(el).toHaveAccessibleName();
  });

  it('names each filter for what it filters', () => {
    render(<BankTxFilters {...props} />);
    for (const name of ['Sort order', 'Allocation status', 'Spent or received', 'Category', 'Suggestion']) {
      expect(screen.getByRole('combobox', { name })).toBeInTheDocument();
    }
    expect(screen.getByRole('spinbutton', { name: 'Min R' })).toBeInTheDocument();
    expect(screen.getByRole('spinbutton', { name: 'Max R' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Search transactions' })).toBeInTheDocument();
  });
});

describe('BankTxFilters: the reconciliation filter (Reviewed tab only)', () => {
  it('is on Reviewed, not on New, and calls onReconFilterChange with the native value', () => {
    const spy = vi.fn();
    const { rerender } = render(<BankTxFilters {...props} onReconFilterChange={spy} />);
    expect(screen.queryByRole('combobox', { name: 'Reconciliation' })).toBeNull();
    rerender(<BankTxFilters {...props} tab="reviewed" onReconFilterChange={spy} />);
    expect(screen.getByRole('combobox', { name: 'Reconciliation' })).toHaveTextContent('All Reviewed');
    fireEvent.click(screen.getByRole('combobox', { name: 'Reconciliation' }));
    fireEvent.click(within(screen.getByRole('listbox')).getByRole('option', { name: 'Not Reconciled' }));
    expect(spy).toHaveBeenCalledWith('unreconciled');
  });
});

describe('BankTxFilters: the filters are kit Selects (NS2) and call their handlers with the native values', () => {
  const CASES: [string, string, keyof BankTxFiltersProps, string][] = [
    ['Sort order', 'Oldest First', 'onSortOrderChange', 'asc'],
    ['Allocation status', 'Suggested', 'onAllocationFilterChange', 'suggested'],
    ['Spent or received', 'Received', 'onTxTypeChange', 'received'],
    ['Category', 'Transfer', 'onAllocTypeChange', 'transfer'],
    ['Suggestion', 'No Suggestion', 'onHasSuggestionChange', 'no'],
  ];
  it.each(CASES)('%s -> %s calls %s(%s)', (name, option, handler, value) => {
    const spy = vi.fn();
    render(<BankTxFilters {...props} {...{ [handler]: spy }} />);
    fireEvent.click(screen.getByRole('combobox', { name }));
    fireEvent.click(within(screen.getByRole('listbox')).getByRole('option', { name: option }));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(value);
  });

  it('shows each current choice and leaves no native select', () => {
    const { container } = render(<BankTxFilters {...props} sortOrder="asc" hasSuggestion="yes" />);
    expect(screen.getByRole('combobox', { name: 'Sort order' })).toHaveTextContent('Oldest First');
    expect(screen.getByRole('combobox', { name: 'Suggestion' })).toHaveTextContent('Has Suggestion');
    expect(container.querySelectorAll('select')).toHaveLength(0);
  });
});
