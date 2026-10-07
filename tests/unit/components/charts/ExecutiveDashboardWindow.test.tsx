/**
 * A BACKWARDS WINDOW IS REFUSED ON THE PAGE, NOT BY A BLANK DASHBOARD.
 *
 * `reports-kpi-scorecard` answers a window whose start is after its end with
 * 400. The page fetched the summary and the scorecard together and
 * `assertOk` on the refused one threw, so the summary that would have loaded
 * was blanked too, under a generic "could not load" banner. The page now
 * checks the window itself: neither request is sent, and the reason sits
 * under the dates.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

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
/** The two report requests the page sends — not its density preference. */
const reportCalls = (): string[] => mockedApiFetch.mock.calls.map(([url]) => String(url))
  .filter((u) => u.includes('/api/accounting/reports-'));

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe('the executive dashboard\'s date window', () => {
  it('sends neither request for a window that runs backwards, and says why', async () => {
    mockedApiFetch.mockImplementation(async () => new Response(JSON.stringify({ data: null }), { status: 200 }));
    const { container } = render(<ExecutiveDashboardPage />);
    await waitFor(() => expect(reportCalls()).toHaveLength(2));

    // The default window starts on 1 January this year; an end the day
    // before it runs backwards.
    const [from, to] = Array.from(container.querySelectorAll('input[type="date"]')) as HTMLInputElement[];
    const end = `${Number(from!.value.slice(0, 4)) - 1}-12-31`;
    fireEvent.change(to!, { target: { value: end } });

    expect(await screen.findByText('The start date is after the end date.')).toBeInTheDocument();
    expect(reportCalls()).toHaveLength(2);
    expect(reportCalls().some((u) => u.includes(`to=${end}`))).toBe(false);
    expect(screen.queryByText(/No financial data available/i)).not.toBeInTheDocument();
  });

  it('fetches again once the window is put right', async () => {
    mockedApiFetch.mockImplementation(async () => new Response(JSON.stringify({ data: null }), { status: 200 }));
    const { container } = render(<ExecutiveDashboardPage />);
    await waitFor(() => expect(reportCalls()).toHaveLength(2));

    const [from, to] = Array.from(container.querySelectorAll('input[type="date"]')) as HTMLInputElement[];
    fireEvent.change(to!, { target: { value: '2025-01-01' } });
    fireEvent.change(from!, { target: { value: '2024-12-01' } });

    await waitFor(() => expect(reportCalls())
      .toContain('/api/accounting/reports-kpi-scorecard?from=2024-12-01&to=2025-01-01'));
    expect(screen.queryByText('The start date is after the end date.')).not.toBeInTheDocument();
  });
});
