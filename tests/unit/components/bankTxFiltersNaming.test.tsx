/**
 * The bank transactions toolbar: every select and input has an accessible name. Its five selects showed only
 * their current option ("All Status"), which axe reports as select-name; Min R / Max R were bare spans.
 */
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render, screen, within } from '@testing-library/react';
import { BankTxFilters, type BankTxFiltersProps } from '@/components/accounting/bank-transactions/BankTxFilters';

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
