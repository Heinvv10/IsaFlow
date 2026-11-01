/**
 * Bank Transactions page CSV downloads: the "Export all accounts" button
 * reaches its handler, the handler refuses without both dates, asks the
 * all-accounts route for exactly the page's range, and reports a refusal
 * instead of saving it; the per-account Export labels rows with the account.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

const apiFetch = vi.fn();
const notifyError = vi.fn();
vi.mock('@/lib/apiFetch', async (orig) => ({
  ...(await orig<typeof import('@/lib/apiFetch')>()),
  apiFetch: (...a: unknown[]) => apiFetch(...a),
}));
vi.mock('@/utils/toast', () => ({ notify: { error: (m: string) => notifyError(m), success: vi.fn() } }));

import { exportAllBankTx, exportLoadedBankTx } from '@/components/accounting/bank-transactions/bankTxExport';
import { BankTxFilters, type BankTxFiltersProps } from '@/components/accounting/bank-transactions/BankTxFilters';
import type { BankTx } from '@/components/accounting/BankTxTable';

const saved: { name: string; text: string }[] = [];

beforeEach(() => {
  apiFetch.mockReset();
  notifyError.mockReset();
  saved.length = 0;
  let blob: Blob | null = null;
  vi.spyOn(URL, 'createObjectURL').mockImplementation((b) => { blob = b as Blob; return 'blob:x'; });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    const name = this.download;
    void blob!.text().then((text) => saved.push({ name, text }));
  });
});

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('exportAllBankTx', () => {
  it('refuses without both dates and never calls the API', async () => {
    await exportAllBankTx('', '2025-04-30');
    await exportAllBankTx('2025-04-01', '');
    expect(apiFetch).not.toHaveBeenCalled();
    expect(notifyError).toHaveBeenCalledTimes(2);
    expect(notifyError.mock.calls[0][0]).toMatch(/From and To dates/);
  });

  it('asks the all-accounts route for the given range and saves its CSV', async () => {
    apiFetch.mockResolvedValue(new Response('"Bank Account"\n"ABSA"', { status: 200 }));
    await exportAllBankTx('2025-04-01', '2025-04-30');
    await flush();
    expect(apiFetch).toHaveBeenCalledWith(
      '/api/accounting/bank-transactions-export-all?from_date=2025-04-01&to_date=2025-04-30');
    expect(saved).toEqual([{ name: 'bank-transactions-all-2025-04-01-to-2025-04-30.csv', text: '"Bank Account"\n"ABSA"' }]);
    expect(notifyError).not.toHaveBeenCalled();
  });

  it('shows the route refusal and saves nothing', async () => {
    apiFetch.mockResolvedValue(new Response(
      JSON.stringify({ success: false, error: { code: 'VALIDATION_ERROR', message: 'narrow the date range' } }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }));
    await exportAllBankTx('2025-01-01', '2025-12-31');
    await flush();
    expect(saved).toEqual([]);
    expect(notifyError).toHaveBeenCalledTimes(1);
  });
});

describe('exportLoadedBankTx', () => {
  it('saves the loaded rows labelled with the selected account', async () => {
    const tx = { id: '1', transactionDate: '2025-04-02', amount: -5, status: 'imported', description: 'a "b"' } as BankTx;
    exportLoadedBankTx([tx], '1110', 'ABSA Current');
    await flush();
    expect(saved[0].name).toBe('bank-transactions-1110.csv');
    expect(saved[0].text.split('\n')[1]).toMatch(/^"ABSA Current","2025-04-02","a ""b"""/);
  });
});

describe('BankTxFilters "Export all accounts" button', () => {
  it('calls onExportAll, not onExport', () => {
    const onExport = vi.fn();
    const onExportAll = vi.fn();
    const noop = vi.fn();
    const props = {
      tab: 'new', page: 1, total: 0, pageSize: 25, selectedCount: 0, selectedBank: 'b1', smartRunning: false,
      showCC: false, showBU: false, showBatchEdit: false, searchTerm: '', fromDate: '', toDate: '',
      fromAmount: '', toAmount: '', sortOrder: 'desc', allocationFilter: 'all', txType: 'all', allocType: 'all', hasSuggestion: 'all',
      onRefresh: noop, onBulkAccept: noop, onBatchAccept: noop, onBatchDelete: noop, onToggleBatchEdit: noop, onExport, onExportAll,
      onApplyRules: noop, onDownloadReport: noop, onSearchChange: noop, onFromDateChange: noop, onToDateChange: noop,
      onFromAmountChange: noop, onToAmountChange: noop, onSortOrderChange: noop, onAllocationFilterChange: noop,
      onTxTypeChange: noop, onAllocTypeChange: noop, onHasSuggestionChange: noop, onToggleCC: noop, onToggleBU: noop,
    } satisfies BankTxFiltersProps;
    render(<BankTxFilters {...props} />);
    fireEvent.click(screen.getByRole('button', { name: /Export all accounts/ }));
    expect(onExportAll).toHaveBeenCalledTimes(1);
    expect(onExport).not.toHaveBeenCalled();
    // The plain Export button exports the loaded page only.
    fireEvent.click(screen.getByRole('button', { name: /^Export$/ }));
    expect(onExport).toHaveBeenCalledTimes(1);
    expect(onExportAll).toHaveBeenCalledTimes(1);
  });
});
