import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, cleanup, act } from '@testing-library/react';

const apiJson = vi.fn();
vi.mock('@/lib/apiFetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/apiFetch')>()), apiJson: (u: string) => apiJson(u),
}));
vi.mock('@/lib/logger', () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { BUDGET_COALESCE_MS, useStatementComparators } from '@/components/accounting/reportControls/useStatementComparators';
import { ApiRequestError } from '@/lib/apiFetch';
import type { StatementRow } from '@/modules/accounting/services/reports/statementRows/statementModel';

import { buildBudgetVsActualLines } from '@/modules/accounting/services/reports/budgetVsActualLines';
const MONTHS = Array.from({ length: 12 }, (_, i) => `2026-${String(i + 1).padStart(2, '0')}`);
const trendsFor = (v: number) => ({ months: MONTHS, byAccountCode: { '1000': MONTHS.map(() => v) }, unavailable: {} });
// The real row model (budgetVsActualLines), so the fixture cannot drift from what the service answers.
const budgetLines = (amount: number) => buildBudgetVsActualLines(
  [{ id: 'g-1000', account_code: '1000', account_name: 'Sales', account_type: 'revenue', actual_amount: 900 }],
  { 'g-1000': amount },
);
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

    // The budget request leaves after the coalescing wait; resolve it once it has.
    await waitFor(() => expect(budgetCalls()).toHaveLength(1));
    await act(async () => { resolveBudget({ lines: budgetLines(500), budgetedCount: 1 }); });
    await waitFor(() => expect(result.current.budgetLoading).toBe(false));
  });
});

const budgetCalls = () => apiJson.mock.calls.map((c) => String(c[0])).filter((u) => u.includes('reports-budget-comparator'));
const BUDGET = (over: Record<string, unknown> = {}) => ({ lines: budgetLines(1000), budgetedCount: 1, ...over });

describe('useStatementComparators — the budget follows the filter (budgets P3 PR-C)', () => {
  it('sends the statement filter: cost_centre_id (either level) and business_unit_id', async () => {
    apiJson.mockResolvedValue(BUDGET());
    const { result } = renderHook(() => useStatementComparators(opts({
      trend: false, budget: true, costCentreId: 'cc-1', businessUnitId: 'bu-1',
    })));
    await waitFor(() => expect(result.current.budgetState).toBe('available'));
    expect(budgetCalls()).toEqual([
      '/api/accounting/reports-budget-comparator?period_start=2026-03-01&period_end=2026-08-31&cost_centre_id=cc-1&business_unit_id=bu-1',
    ]);
  });

  it('carries what the service said about the window: no-budget years, unallocated budget, partial accounts', async () => {
    apiJson.mockResolvedValue(BUDGET({ budgetedCount: 0, noBudgetYears: [2026], unallocatedBudget: null, partialBudgetCount: 0 }));
    const { result } = renderHook(() => useStatementComparators(opts({ trend: false, budget: true })));
    await waitFor(() => expect(result.current.budgetState).toBe('none'));
    expect(result.current.budgetInfo).toEqual({ noBudgetYears: [2026], unallocatedBudget: null, partialBudgetCount: 0, retryAfterSecs: null });
  });

  it('coalesces a run of period and filter changes into ONE request, for the last of them', async () => {
    apiJson.mockResolvedValue(BUDGET());
    const { result, rerender } = renderHook(
      (p: { end: string; cc: string }) => useStatementComparators(opts({ trend: false, budget: true, periodEnd: p.end, costCentreId: p.cc })),
      { initialProps: { end: '2026-08-01', cc: '' } },
    );
    for (const [end, cc] of [['2026-08-02', ''], ['2026-08-03', 'cc-1'], ['2026-08-31', 'cc-1']] as const) rerender({ end, cc });
    expect(result.current.budgetLoading).toBe(true);
    await waitFor(() => expect(result.current.budgetState).toBe('available'));
    expect(budgetCalls()).toEqual([
      '/api/accounting/reports-budget-comparator?period_start=2026-03-01&period_end=2026-08-31&cost_centre_id=cc-1',
    ]);
    expect(BUDGET_COALESCE_MS).toBeGreaterThanOrEqual(250);
  });

  it('a 429 is "limited" with the wait, never "failed" or "none"; Retry asks again, once per click', async () => {
    apiJson.mockRejectedValueOnce(new ApiRequestError('Too many report requests: try again in 5 minutes.', 429, 250));
    const { result } = renderHook(() => useStatementComparators(opts({ trend: false, budget: true })));
    await waitFor(() => expect(result.current.budgetState).toBe('limited'));
    expect(result.current.budgetInfo.retryAfterSecs).toBe(250);
    expect(result.current.apply(ROW())[0]!.budget).toBeUndefined();
    // Nothing retries on its own.
    await new Promise((r) => setTimeout(r, BUDGET_COALESCE_MS + 100));
    expect(budgetCalls()).toHaveLength(1);

    apiJson.mockResolvedValueOnce(BUDGET());
    act(() => { result.current.retryBudget(); });
    await waitFor(() => expect(result.current.budgetState).toBe('available'));
    expect(budgetCalls()).toHaveLength(2);
  });

  it("withAuth's shared limiter (no Retry-After) is limited too, with no known wait", async () => {
    apiJson.mockRejectedValueOnce(new ApiRequestError('Too many requests', 429));
    const { result } = renderHook(() => useStatementComparators(opts({ trend: false, budget: true })));
    await waitFor(() => expect(result.current.budgetState).toBe('limited'));
    expect(result.current.budgetInfo.retryAfterSecs).toBeNull();
  });
});
