/**
 * WP4b toolbar: "Actions" is "Refresh"; Import / Export / Export all / Recon Report live in a "More" menu; "All
 * Categories" is named for what it filters (allocation type); the selection actions are a contextual bar that appears
 * only while something is selected (the page's always-mounted live region still says "N selected"); the less-used filters fold
 * behind a "Filters" toggle, open by default on a wide screen or while one of them narrows the list.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BankTxFilters, type BankTxFiltersProps } from '@/components/accounting/bank-transactions/BankTxFilters';

vi.mock('next/link', () => ({ default: ({ children, href, ...r }: { children: React.ReactNode; href: string }) => <a href={href} {...r}>{children}</a> }));
const push = vi.fn();
vi.mock('next/router', () => ({ default: { push: (...a: unknown[]) => push(...a) } }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const props = (): BankTxFiltersProps => ({
  tab: 'new', page: 1, total: 40, pageSize: 25, selectedCount: 0, selectedBank: 'b1', smartRunning: false,
  showCC: false, showBU: false, showBatchEdit: false, searchTerm: '', fromDate: '', toDate: '',
  fromAmount: '', toAmount: '', sortOrder: 'desc', allocationFilter: 'all', txType: 'all', allocType: 'all', hasSuggestion: 'all', reconFilter: 'all',
  onRefresh: vi.fn(), onBulkAccept: vi.fn(), onBatchAccept: vi.fn(), onBatchDelete: vi.fn(), onToggleBatchEdit: vi.fn(), onExport: vi.fn(),
  onExportAll: vi.fn(), onApplyRules: vi.fn(), onDownloadReport: vi.fn(), onSearchChange: vi.fn(), onFromDateChange: vi.fn(), onToDateChange: vi.fn(),
  onFromAmountChange: vi.fn(), onToAmountChange: vi.fn(), onSortOrderChange: vi.fn(), onAllocationFilterChange: vi.fn(),
  onTxTypeChange: vi.fn(), onAllocTypeChange: vi.fn(), onHasSuggestionChange: vi.fn(), onReconFilterChange: vi.fn(), onToggleCC: vi.fn(), onToggleBU: vi.fn(),
  onClearSelection: vi.fn(),
});

describe('the toolbar', () => {
  it('"Actions" is now "Refresh"', () => {
    const p = props();
    render(<BankTxFilters {...p} />);
    expect(screen.queryByRole('button', { name: 'Actions' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(p.onRefresh).toHaveBeenCalledTimes(1);
  });

  it('Import, Export this page, Export all accounts and Recon Report are in the More menu, not on the bar', () => {
    const p = props();
    render(<BankTxFilters {...p} />);
    for (const name of [/Import Bank Statements/i, /Export this page/i, /Export all accounts/i, /Recon Report/i]) {
      expect(screen.queryByRole('button', { name })).toBeNull();
      expect(screen.queryByRole('link', { name })).toBeNull();
    }
    const more = screen.getByRole('button', { name: 'More' });
    fireEvent.click(more);
    const menu = screen.getByRole('menu');
    expect(within(menu).getAllByRole('menuitem').map(i => i.textContent)).toEqual(['Import bank statements', 'Export this page', 'Export all accounts', 'Recon report']);
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Export this page' }));
    expect(p.onExport).toHaveBeenCalledTimes(1);
    fireEvent.click(more); fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Export all accounts' }));
    expect(p.onExportAll).toHaveBeenCalledTimes(1);
    fireEvent.click(more); fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Recon report' }));
    expect(p.onDownloadReport).toHaveBeenCalledTimes(1);
    fireEvent.click(more);
    // Import is a real link (new tab, middle-click), not a button that pushes the router.
    const imp = within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Import bank statements' });
    expect(imp.tagName).toBe('A');
    expect(imp.getAttribute('href')).toBe('/accounting/bank-reconciliation/import');
    // From the keyboard, Enter follows it.
    imp.focus();
    fireEvent.keyDown(imp, { key: 'Enter' });
    expect(push).toHaveBeenCalledWith('/accounting/bank-reconciliation/import');
  });

  it('Recon report needs an account', () => {
    render(<BankTxFilters {...props()} selectedBank="" />);
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    expect(screen.getByRole('menuitem', { name: 'Recon report' })).toBeDisabled();
  });

  it('the category filter is named for what it filters: allocation type', () => {
    render(<BankTxFilters {...props()} />);
    fireEvent.click(screen.getByRole('button', { name: /^Filters/ }));
    expect(screen.queryByRole('combobox', { name: 'Category' })).toBeNull();
    expect(screen.getByRole('combobox', { name: 'Allocation type' })).toHaveTextContent('All allocation types');
  });
});

describe('the contextual selection bar', () => {
  it('nothing selected: no selection bar and no selection actions', () => {
    render(<BankTxFilters {...props()} />);
    expect(screen.queryByTestId('bank-tx-selection-bar')).toBeNull();
    for (const name of ['Mark as Reviewed', 'Batch Allocate', 'Delete', 'Batch Edit']) expect(screen.queryByRole('button', { name })).toBeNull();
  });

  it('rows selected: the bar replaces the action buttons and carries every selection action', () => {
    const p = props();
    render(<BankTxFilters {...p} selectedCount={3} />);
    const bar = screen.getByTestId('bank-tx-selection-bar');
    expect(within(bar).getByTestId('bank-tx-selected-count')).toHaveTextContent('3 selected');
    expect(screen.queryByRole('button', { name: 'Smart Categorize' })).toBeNull();
    for (const [name, fn] of [['Mark as Reviewed', p.onBulkAccept], ['Batch Allocate', p.onBatchAccept], ['Batch Edit', p.onToggleBatchEdit], ['Delete', p.onBatchDelete], ['Clear selection', p.onClearSelection]] as const) {
      fireEvent.click(within(bar).getByRole('button', { name }));
      expect(fn).toHaveBeenCalledTimes(1);
    }
  });

  it('while rows are ticked the bar sticks to the top of the list (row 80 of 100 still sees it); otherwise it scrolls away', () => {
    const { rerender } = render(<BankTxFilters {...props()} />);
    expect(screen.getByTestId('bank-tx-toolbar').className.split(/\s+/)).not.toContain('sticky');
    rerender(<BankTxFilters {...props()} selectedCount={1} />);
    expect(screen.getByTestId('bank-tx-toolbar').className.split(/\s+/)).toEqual(expect.arrayContaining(['sticky', 'top-0']));
  });

  it('BankTxFilters hands the bar the busy keys and the batch progress', () => {
    render(<BankTxFilters {...props()} selectedCount={2} busy={new Set(['delete'])} progress={{ key: 'batch-allocate', done: 1, total: 5 }} />);
    const bar = screen.getByTestId('bank-tx-selection-bar');
    expect(within(bar).getByRole('button', { name: 'Mark as Reviewed' })).toBeDisabled();
    expect(within(bar).getByRole('button', { name: /Allocating 2 of 5/ })).toBeInTheDocument();
  });

  it('with a selection the page actions stay reachable: Refresh on the bar, the rest first in More', () => {
    const p = props();
    render(<BankTxFilters {...p} selectedCount={2} />);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(p.onRefresh).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    const items = within(screen.getByRole('menu')).getAllByRole('menuitem');
    expect(items.map(i => i.textContent)).toEqual(['Smart Categorize', 'New transaction', 'Import bank statements', 'Export this page', 'Export all accounts', 'Recon report']);
    expect(items[1]!.getAttribute('href')).toBe('/accounting/bank-transactions/new');
    fireEvent.click(items[0]!);
    expect(p.onApplyRules).toHaveBeenCalledTimes(1);
  });

  it('with a selection the bar keeps one row: Refresh is its icon (same name), the row range gives way to the pager\'s', () => {
    const { rerender } = render(<BankTxFilters {...props()} />);
    expect(screen.getByText('1–25 of 40')).toBeInTheDocument();
    const refresh = screen.getByRole('button', { name: 'Refresh' });
    rerender(<BankTxFilters {...props()} selectedCount={1} />);
    expect(screen.queryByText('1–25 of 40')).toBeNull();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBe(refresh); // the same element: focus can rest on it
    expect(refresh.textContent?.trim()).toBe('');
  });

  it('a running Smart Categorize stays visible while a selection is active', () => {
    render(<BankTxFilters {...props()} selectedCount={2} smartRunning />);
    expect(screen.getByTestId('bank-tx-smart-running')).toHaveTextContent('Categorizing...');
  });

  it('when the selection bar goes (Clear, Mark as Reviewed, Delete) focus lands on Refresh, not on <body>', () => {
    const { rerender } = render(<BankTxFilters {...props()} selectedCount={2} />);
    screen.getByRole('button', { name: 'Clear selection' }).focus();
    rerender(<BankTxFilters {...props()} selectedCount={0} />);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Refresh' }));
  });

  it('...but focus that went somewhere else (a dialog, a field) is left there', () => {
    const { rerender } = render(<><input aria-label="elsewhere" /><BankTxFilters {...props()} selectedCount={2} /></>);
    screen.getByLabelText('elsewhere').focus();
    rerender(<><input aria-label="elsewhere" /><BankTxFilters {...props()} selectedCount={0} /></>);
    expect(document.activeElement).toBe(screen.getByLabelText('elsewhere'));
  });

  it('the selection actions show only on the New tab', () => {
    render(<BankTxFilters {...props()} tab="reviewed" selectedCount={2} />);
    expect(screen.queryByRole('button', { name: 'Mark as Reviewed' })).toBeNull();
  });
});

describe('the Filters toggle', () => {
  it('at a narrow width the date, amount and other filters are folded; the toggle opens them', () => {
    render(<BankTxFilters {...props()} />);
    const toggle = screen.getByRole('button', { name: 'Filters' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByLabelText('From date')).toBeNull();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByLabelText('From date')).toBeInTheDocument();
    for (const name of ['Sort order', 'Spent or received', 'Allocation type', 'Suggestion']) expect(screen.getByRole('combobox', { name })).toBeInTheDocument();
  });

  it('a folded filter that narrows the list opens the panel and is counted on the toggle', () => {
    render(<BankTxFilters {...props()} fromDate="2026-01-01" txType="spent" />);
    const toggle = screen.getByRole('button', { name: 'Filters (2)' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByLabelText('From date')).toBeInTheDocument();
  });

  it('a sort other than newest first is out of sight too: it opens the panel and is counted', () => {
    render(<BankTxFilters {...props()} sortOrder="asc" />);
    expect(screen.getByRole('button', { name: 'Filters (1)' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('open by default on a wide screen (>= 1536px), and it follows the width across 1536px', () => {
    let listener: (() => void) | undefined;
    const mq = { matches: true, addEventListener: (_: string, l: () => void) => { listener = l; }, removeEventListener: vi.fn() };
    const spy = vi.spyOn(window, 'matchMedia').mockImplementation(() => mq as unknown as MediaQueryList);
    try {
      render(<BankTxFilters {...props()} />);
      const toggle = screen.getByRole('button', { name: 'Filters' });
      expect(toggle).toHaveAttribute('aria-expanded', 'true'); // from the first render: no closed-then-open jump
      expect(toggle).toHaveAttribute('aria-controls', 'bank-tx-filter-panel');
      mq.matches = false;
      act(() => listener!());
      expect(toggle).toHaveAttribute('aria-expanded', 'false');
      expect(toggle).not.toHaveAttribute('aria-controls'); // no reference to a panel that is not there
    } finally { spy.mockRestore(); }
  });

  it('search and the status filter stay on the bar', () => {
    render(<BankTxFilters {...props()} />);
    expect(screen.getByRole('textbox', { name: 'Search transactions' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Allocation status' })).toBeInTheDocument();
  });
});
