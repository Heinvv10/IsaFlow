/**
 * WP4b list footer: rows per page (25 / 50 / 100, remembered in this browser) and the coding-metrics line, moved off
 * the top of the list and labelled company-wide (it counts every bank account, not the one on screen). No second
 * density toggle: the header's drives the grid. The loading skeleton draws as many rows as the page holds.
 */
import { act, cleanup, fireEvent, render, screen, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BankTxListFooter } from '@/components/accounting/bank-transactions/BankTxListFooter';
import { CodingMetricsStrip } from '@/components/accounting/bank-transactions/CodingMetricsStrip';
import { TableDensityProvider } from '@/contexts/TableDensityContext';
import { useBankTxFilters } from '@/components/accounting/bank-transactions/useBankTxFilters';
import { computeCodingMetrics } from '@/modules/accounting/services/bank/codingMetrics';
import { PAGE_SIZE_KEY, readPageSizePref } from '@/components/accounting/bank-transactions/bankTxPageSizePref';
import { BankTxLoading } from '@/components/accounting/bank-transactions/BankTxListStates';
import { BankTxListFrame } from '@/components/accounting/bank-transactions/BankTxListFrame';

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/lib/apiFetch', async (orig) => ({ ...(await orig<typeof import('@/lib/apiFetch')>()), apiFetch }));
afterEach(() => { cleanup(); apiFetch.mockReset(); localStorage.clear(); });

const metrics = computeCodingMetrics({
  companyId: 'c1', linesCoded: 10, linesAutoCoded: 5, suggestionsDecided: 0, suggestionsAccepted: 0, autoPosted: 0,
  autoPostedReversed: 0, firstBatchAt: null, firstLineAt: null, firstWindowDecided: 0, firstWindowAccepted: 0, decisionLogSince: null,
});
const ok = () => new Response(JSON.stringify({ success: true, data: { minDecisions: 20, metrics } }), { status: 200, headers: { 'Content-Type': 'application/json' } });

describe('rows per page', () => {
  it('offers 25, 50 and 100 and reports the choice', async () => {
    apiFetch.mockResolvedValue(ok());
    const onPageSize = vi.fn();
    render(<BankTxListFooter pageSize={25} onPageSize={onPageSize} />);
    const select = screen.getByRole('combobox', { name: 'Rows per page' });
    expect(select).toHaveTextContent('25');
    fireEvent.click(select);
    expect(screen.getAllByRole('option').map(o => o.textContent)).toEqual(['25', '50', '100']);
    fireEvent.click(screen.getByRole('option', { name: '50' }));
    expect(onPageSize).toHaveBeenCalledWith(50);
  });

  it('a new page size goes back to page 1; Clear and an account switch keep it', () => {
    const setPage = vi.fn();
    const { result } = renderHook(() => useBankTxFilters(setPage));
    act(() => result.current.setPageSize(100));
    expect(result.current.pageSize).toBe(100);
    expect(setPage).toHaveBeenLastCalledWith(1);
    act(() => result.current.clear());
    act(() => result.current.resetForAccount());
    expect(result.current.pageSize).toBe(100);
    expect(result.current.values.pageSize).toBe(100);
  });
});

describe('the sort is listed and cleared with the filters', () => {
  it('"Sort: oldest first" is an active label; Clear and an account switch reset it', () => {
    const { result } = renderHook(() => useBankTxFilters(vi.fn()));
    act(() => result.current.setSortOrder('asc'));
    expect(result.current.activeLabels).toContain('Sort: oldest first');
    act(() => result.current.clear());
    expect(result.current.sortOrder).toBe('desc');
    expect(result.current.activeLabels).toEqual([]);
    act(() => result.current.setSortOrder('asc'));
    act(() => result.current.resetForAccount());
    expect(result.current.sortOrder).toBe('desc');
  });
});

describe('density', () => {
  // ONE density toggle: the header's (TableDensityContext). The bank grid follows it: xs selects and 33px rows in
  // compact (bankTxSelectionPopoverUxb.test "compact: xs selects", golden z15 "bank transaction rows shrink").
  it('the footer adds no second density toggle', async () => {
    apiFetch.mockResolvedValue(ok());
    render(<TableDensityProvider><BankTxListFooter pageSize={25} onPageSize={vi.fn()} /></TableDensityProvider>);
    expect(screen.queryByRole('button', { name: /^Compact/ })).toBeNull();
    expect(screen.queryByRole('group', { name: 'Table row density' })).toBeNull();
  });
});

describe('the page size is remembered in this browser', () => {
  it('choosing a size stores it; the stored size reads back; junk reads as none', () => {
    const { result } = renderHook(() => useBankTxFilters(vi.fn()));
    act(() => result.current.setPageSize(50));
    expect(localStorage.getItem(PAGE_SIZE_KEY)).toBe('50');
    expect(readPageSizePref()).toBe(50);
    localStorage.setItem(PAGE_SIZE_KEY, '37');
    expect(readPageSizePref()).toBeUndefined();
  });
});

describe('the loading skeleton', () => {
  it('draws as many rows as the page holds', () => {
    render(<BankTxLoading rows={50} />);
    const rows = Array.from(screen.getByTestId('list-skeleton').children).filter(c => c.className.includes('flex'));
    expect(rows).toHaveLength(50);
  });
  it('the list frame hands it the page size', () => {
    render(<BankTxListFrame relinkFailed={false} aiPolling={0} isLoading error="" empty pastEnd={false} tab="new" onDetailClose={vi.fn()} pageSize={100}><div /></BankTxListFrame>);
    const rows = Array.from(screen.getByTestId('list-skeleton').children).filter(c => c.className.includes('flex'));
    expect(rows).toHaveLength(100);
  });
});

describe('coding metrics in the footer', () => {
  it('the footer carries the coding line, labelled company-wide', async () => {
    apiFetch.mockResolvedValue(ok());
    render(<BankTxListFooter pageSize={25} onPageSize={vi.fn()} />);
    const strip = await screen.findByLabelText('IsaFlow coding, company-wide (every bank account)');
    expect(strip).toHaveTextContent(/^Company-wide:/);
    expect(strip).toHaveTextContent('Auto-coded by IsaFlow: 50% of lines this month');
  });

  it('the strip on its own says company-wide too', async () => {
    apiFetch.mockResolvedValue(ok());
    render(<CodingMetricsStrip />);
    expect(await screen.findByText('Company-wide:')).toBeInTheDocument();
  });
});
