/**
 * One `useDensity` per page.
 *
 * `useComparatorColumns` used to call `useDensity()` itself. A page that also
 * renders a `DensityToggle` — the executive dashboard already does — then
 * holds two independent copies of the same preference: two GETs of
 * /api/auth/preferences on mount, and a toggle whose change the seeding copy
 * never observes. The density is passed in instead.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';

vi.mock('@/components/layout/AppLayout', () => ({
  AppLayout: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, isReady: true, push: vi.fn() }) }));
vi.mock('@/lib/logger', () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

const apiJson = vi.fn();
vi.mock('@/lib/apiFetch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/apiFetch')>();
  return { ...actual, apiFetch: vi.fn(), apiJson: (u: string) => apiJson(u) };
});

import { apiFetch } from '@/lib/apiFetch';
import IncomeStatementPage from '@/../pages/accounting/reports/income-statement';

const mockedApiFetch = vi.mocked(apiFetch);

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('the income statement page', () => {
  it('reads the density preference exactly once', async () => {
    mockedApiFetch.mockImplementation(async (url: string) => {
      if (url.includes('preferences')) {
        return new Response(JSON.stringify({ data: { reports_density: 'accountant' } }), { status: 200 });
      }
      if (url.includes('cost-centres')) return new Response(JSON.stringify({ data: [] }), { status: 200 });
      if (url.includes('fiscal-periods')) return new Response(JSON.stringify({ data: null }), { status: 200 });
      return new Response(JSON.stringify({ data: {
        periodStart: '2026-08-01', periodEnd: '2026-08-31',
        revenue: [], otherIncome: [], costOfSales: [], operatingExpenses: [], otherExpenses: [],
        totalRevenue: 0, totalOtherIncome: 0, totalCostOfSales: 0,
        totalOperatingExpenses: 0, totalOtherExpenses: 0,
        grossProfit: 0, operatingProfit: 0, netProfit: 0,
      } }), { status: 200 });
    });
    apiJson.mockResolvedValue({ months: [], byAccountCode: {}, unavailable: {}, lines: [], budgetedCount: 0 });

    render(<IncomeStatementPage />);

    // The accountant seed has landed, so the density fetch has resolved.
    await waitFor(() =>
      expect((screen.getByLabelText('Prior period') as HTMLInputElement).checked).toBe(true));

    const preferenceReads = mockedApiFetch.mock.calls
      .map(c => String(c[0]))
      .filter(u => u.includes('/api/auth/preferences'));
    expect(preferenceReads).toHaveLength(1);
  });
});
