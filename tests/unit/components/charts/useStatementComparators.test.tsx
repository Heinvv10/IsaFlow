import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, cleanup, act } from '@testing-library/react';

const apiJson = vi.fn();
vi.mock('@/lib/apiFetch', () => ({ apiJson: (u: string) => apiJson(u) }));
vi.mock('@/lib/logger', () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { useStatementComparators } from '@/components/accounting/reportControls/useStatementComparators';
import type { StatementRow } from '@/modules/accounting/services/reports/statementRows/statementModel';

const MONTHS = Array.from({ length: 12 }, (_, i) => `2026-${String(i + 1).padStart(2, '0')}`);
const trendsFor = (v: number) => ({ months: MONTHS, byAccountCode: { '1000': MONTHS.map(() => v) }, unavailable: {} });
const budgetLines = (amount: number) => ([{
  account_code: '1000', account_name: 'Sales', account_type: 'revenue',
  budget_amount: amount, actual_amount: 900, variance: 0, variance_pct: 0,
}]);
const ROW = (): StatementRow[] => ([
  { id: 'acc:1000', kind: 'line', label: 'Sales', depth: 1, accountCode: '1000', actual: 900 },
]);

const opts = (over: Partial<Parameters<typeof useStatementComparators>[0]> = {}) => ({
  trend: true, budget: false, asOf: '2026-08-31', basis: 'movement' as const,
  periodStart: '2026-03-01', periodEnd: '2026-08-31', ...over,
});

beforeEach(() => { apiJson.mockReset(); });
afterEach(cleanup);

describe('useStatementComparators — a failed fetch', () => {
  it('reports the trend failure instead of leaving an empty column that means "no series"', async () => {
    apiJson.mockRejectedValue(new Error('500'));
    const { result } = renderHook(() => useStatementComparators(opts()));
    await waitFor(() => expect(result.current.trendFailed).toBe(true));
    expect(result.current.apply(ROW())[0]!.trend).toBeUndefined();
  });

  it('reports the budget failure as failed, never as "no budget captured"', async () => {
    apiJson.mockRejectedValue(new Error('500'));
    const { result } = renderHook(() => useStatementComparators(opts({ trend: false, budget: true })));
    await waitFor(() => expect(result.current.budgetState).toBe('failed'));
  });

  it('does not claim a trend failure when the trend was never asked for', async () => {
    apiJson.mockRejectedValue(new Error('500'));
    const { result } = renderHook(() => useStatementComparators(opts({ trend: false, budget: true })));
    await waitFor(() => expect(result.current.budgetState).toBe('failed'));
    expect(result.current.trendFailed).toBe(false);
  });
});

describe('useStatementComparators — the budget signal comes from the service', () => {
  it('is "none" when the service budgeted no accounts, even though lines came back', async () => {
    apiJson.mockResolvedValue({ lines: budgetLines(0), budgetedCount: 0 });
    const { result } = renderHook(() => useStatementComparators(opts({ trend: false, budget: true })));
    await waitFor(() => expect(result.current.budgetState).toBe('none'));
    // And the comparator is not applied, so no variance is printed against a
    // target nobody set.
    expect(result.current.apply(ROW())[0]!.budget).toBeUndefined();
  });

  it('is "available" — and applies — when the service budgeted an account', async () => {
    apiJson.mockResolvedValue({ lines: budgetLines(1000), budgetedCount: 1 });
    const { result } = renderHook(() => useStatementComparators(opts({ trend: false, budget: true })));
    await waitFor(() => expect(result.current.budgetState).toBe('available'));
    expect(result.current.apply(ROW())[0]!.budget?.value).toBe(1000);
  });

  it('trusts the count over the amounts: every line zero but one budgeted still applies', async () => {
    // A budget captured as zero on every line is a real budget. Inferring
    // "no budget" from all-zero amounts would silently discard it.
    apiJson.mockResolvedValue({ lines: budgetLines(0), budgetedCount: 1 });
    const { result } = renderHook(() => useStatementComparators(opts({ trend: false, budget: true })));
    await waitFor(() => expect(result.current.budgetState).toBe('available'));
    expect(result.current.apply(ROW())[0]!.budget?.value).toBe(0);
  });
});

describe('useStatementComparators — the balance sheet shape', () => {
  it('fetches no budget and reports "unknown" when budget is left off entirely', async () => {
    apiJson.mockResolvedValue(trendsFor(3));
    // What balance-sheet.tsx passes: no `budget`, no period bounds. A budget
    // is a P&L figure and its account codes match nothing here.
    const { result } = renderHook(() => useStatementComparators({
      trend: true, asOf: '2026-08-31', basis: 'balance' as const,
    }));
    await waitFor(() => expect(result.current.apply(ROW())[0]!.trend?.[0]).toBe(3));
    expect(apiJson.mock.calls.map(c => String(c[0]))).toEqual([
      '/api/accounting/reports-account-trends?as_of=2026-08-31&basis=balance',
    ]);
    expect(result.current.budgetState).toBe('unknown');
  });
});

describe('useStatementComparators — stale data', () => {
  it('drops the previous window\'s trend the moment the period changes', async () => {
    let resolveSecond: (v: unknown) => void = () => {};
    apiJson
      .mockResolvedValueOnce(trendsFor(111))
      .mockImplementationOnce(() => new Promise(r => { resolveSecond = r; }));

    const { result, rerender } = renderHook(
      (p: { asOf: string }) => useStatementComparators(opts({ asOf: p.asOf })),
      { initialProps: { asOf: '2026-08-31' } },
    );
    await waitFor(() => expect(result.current.apply(ROW())[0]!.trend?.[0]).toBe(111));

    rerender({ asOf: '2026-07-31' });
    // The old series must be gone BEFORE the new one lands. Left in place it
    // draws the previous window beside freshly loaded figures.
    expect(result.current.apply(ROW())[0]!.trend).toBeUndefined();

    await act(async () => { resolveSecond(trendsFor(222)); });
    await waitFor(() => expect(result.current.apply(ROW())[0]!.trend?.[0]).toBe(222));
  });

  it('clears a previous failure when the period changes, rather than reporting it forever', async () => {
    apiJson.mockRejectedValueOnce(new Error('500')).mockResolvedValueOnce(trendsFor(7));
    const { result, rerender } = renderHook(
      (p: { asOf: string }) => useStatementComparators(opts({ asOf: p.asOf })),
      { initialProps: { asOf: '2026-08-31' } },
    );
    await waitFor(() => expect(result.current.trendFailed).toBe(true));
    rerender({ asOf: '2026-07-31' });
    await waitFor(() => expect(result.current.trendFailed).toBe(false));
  });
});

describe('useStatementComparators — loading is per fetch', () => {
  it('does not report the budget as loaded because the trend finished', async () => {
    let resolveBudget: (v: unknown) => void = () => {};
    apiJson.mockImplementation((url: string) => url.includes('trends')
      ? Promise.resolve(trendsFor(1))
      : new Promise(r => { resolveBudget = r; }));

    const { result } = renderHook(() => useStatementComparators(opts({ trend: true, budget: true })));
    await waitFor(() => expect(result.current.trendLoading).toBe(false));
    expect(result.current.budgetLoading).toBe(true);

    await act(async () => { resolveBudget({ lines: budgetLines(500), budgetedCount: 1 }); });
    await waitFor(() => expect(result.current.budgetLoading).toBe(false));
  });
});
