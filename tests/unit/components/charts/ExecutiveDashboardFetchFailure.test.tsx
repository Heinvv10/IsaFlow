/**
 * `apiFetch` resolves on a 4xx/5xx status (see feedback_apifetch_resolves_on_4xx
 * in the reporting worktree's memory). Reading `.then(r => r.json())` with no
 * `res.ok` check turned a failed request into an empty summary, which the
 * page then rendered as "No financial data available for the selected
 * period" — claiming the ledger has nothing for the range instead of
 * reporting the failure that actually happened. Mirrors the pattern already
 * used on the income-statement page (assertOk + a visible error banner).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

vi.mock('@/components/layout/AppLayout', () => ({
  AppLayout: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/lib/apiFetch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/apiFetch')>();
  return { ...actual, apiFetch: vi.fn() };
});

import { apiFetch } from '@/lib/apiFetch';
import ExecutiveDashboardPage from '@/../pages/accounting/reports/executive-dashboard';

const mockedApiFetch = vi.mocked(apiFetch);

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe('the executive dashboard on a failed fetch', () => {
  it('shows a visible error instead of claiming there is no financial data', async () => {
    mockedApiFetch.mockImplementation(async () =>
      new Response(JSON.stringify({ message: 'Session expired' }), { status: 401 }));

    render(<ExecutiveDashboardPage />);

    expect(await screen.findByText('Session expired')).toBeInTheDocument();
    expect(screen.queryByText(/No financial data available/i)).not.toBeInTheDocument();
  });

  it('shows the empty-data message only when the fetch actually succeeded with nothing', async () => {
    mockedApiFetch.mockImplementation(async () =>
      new Response(JSON.stringify({ data: null }), { status: 200 }));

    render(<ExecutiveDashboardPage />);

    expect(await screen.findByText(/No financial data available/i)).toBeInTheDocument();
  });
});
