/**
 * WP4b list footer: rows per page (25 / 50 / 100), the table density toggle wired to TableDensityContext (offered only
 * where a provider is mounted), and the coding-metrics line, moved off the top of the list and labelled company-wide
 * (it counts every bank account, not the one on screen).
 */
import { act, cleanup, fireEvent, render, screen, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BankTxListFooter } from '@/components/accounting/bank-transactions/BankTxListFooter';
import { CodingMetricsStrip } from '@/components/accounting/bank-transactions/CodingMetricsStrip';
import { TableDensityProvider } from '@/contexts/TableDensityContext';
import { useBankTxFilters } from '@/components/accounting/bank-transactions/useBankTxFilters';
import { computeCodingMetrics } from '@/modules/accounting/services/bank/codingMetrics';

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
  it('the toggle is the TableDensityContext one: compact sets the shared density', async () => {
    apiFetch.mockResolvedValue(ok());
    render(<TableDensityProvider><BankTxListFooter pageSize={25} onPageSize={vi.fn()} /></TableDensityProvider>);
    fireEvent.click(screen.getByRole('button', { name: /^Compact/ }));
    expect(localStorage.getItem('isaflow.tableDensity')).toBe('compact');
    expect(document.documentElement.dataset.density).toBe('compact');
  });

  it('no provider: no toggle (it would do nothing)', async () => {
    apiFetch.mockResolvedValue(ok());
    render(<BankTxListFooter pageSize={25} onPageSize={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /^Compact/ })).toBeNull();
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
