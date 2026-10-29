/**
 * Budgets P3 PR-B review r1: the Budget vs Actual page's state.
 * - L5: the controls live in the page URL. A URL's controls are the first
 *   request; a change is written back (shallow replace), so Back and a shared
 *   link reopen the same report.
 * - M4: a response that arrives after a newer request is dropped, so a slow
 *   earlier window never replaces a later one; a load that fails after a good
 *   one clears the report: no rows, the error, and the exports disabled.
 * - Browser review r1: rapid control changes are coalesced into one request;
 *   a refusal (429) shows the server's wait and a Retry button that re-sends
 *   the same request; an inverted custom range says so and sends nothing; the
 *   Quarter period opens on the quarter holding today (Q1 for a year that
 *   does not hold today), as Month opens on the month holding today.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { apiFetch } from '@/lib/apiFetch';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { ok } from '../helpers/d2R3a5';
import { trackingReport } from '../helpers/budgetTrackingReportFixture';

const route = vi.hoisted(() => ({
  query: {} as Record<string, string>, isReady: true, push: () => Promise.resolve(true),
  replace: (() => Promise.resolve(true)) as (url: string, as?: unknown, opts?: unknown) => Promise<boolean>,
}));
vi.mock('next/router', () => ({ useRouter: () => route }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/accounting/budgets/tracking/BudgetTrackingVisuals', () => ({ BudgetTrackingVisuals: () => null }));

import BudgetVsActualPage from '../../../pages/accounting/reports/budget-vs-actual';

useApiJsonOverMock();
const CC1 = '11111111-1111-4111-8111-111111111111';
const VERSION = '44444444-4444-4444-8444-444444444444';
let replaced: string[] = [];
beforeEach(() => {
  route.query = {};
  replaced = [];
  route.replace = (url: string) => { replaced.push(url); return Promise.resolve(true); };
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const reportQueries = () => vi.mocked(apiFetch).mock.calls.map(([u]) => String(u))
  .filter((u) => u.includes('reports-budget-tracking')).map((u) => Object.fromEntries(new URL(u, 'http://x').searchParams));
const named = (name: string) => trackingReport([{ code: '4000', name, type: 'revenue', actual: 5, budget: 10 }]);

describe('controls in the page URL', () => {
  it('a URL with a period, year, quarter, version and filter is the first request', async () => {
    route.query = { period: 'quarter', fiscal_year: '2026', quarter: '2', version_id: VERSION, cc1_id: CC1, bogus: 'x' };
    vi.mocked(apiFetch).mockReset().mockImplementation(async () => ok(named('Sales')));
    render(<BudgetVsActualPage />);
    await screen.findByRole('button', { name: /Sales/ });
    expect(reportQueries()).toEqual([{ period: 'quarter', fiscal_year: '2026', quarter: '2', version_id: VERSION, cc1_id: CC1 }]);
  });

  it("a period's parameter that does not apply, and a malformed id, are dropped rather than sent", async () => {
    route.query = { period: 'month', fiscal_year: '2026', month: '2026-13', cc1_id: 'nope' };
    vi.mocked(apiFetch).mockReset().mockImplementation(async () => ok(named('Sales')));
    render(<BudgetVsActualPage />);
    await screen.findByRole('button', { name: /Sales/ });
    expect(reportQueries()).toEqual([{ period: 'month', group_by: 'cc1' }]);
  });

  it('a change is written back to the URL', async () => {
    vi.mocked(apiFetch).mockReset().mockImplementation(async () => ok(named('Sales')));
    render(<BudgetVsActualPage />);
    await screen.findByRole('button', { name: /Sales/ });
    fireEvent.change(screen.getByTestId('bva-period'), { target: { value: 'fy' } });
    await waitFor(() => expect(replaced.at(-1)).toBe('/accounting/reports/budget-vs-actual?period=fy'));
  });
});

describe('responses that race or fail', () => {
  it('a slow earlier response never replaces a later one', async () => {
    let releaseYtd: () => void = () => {};
    vi.mocked(apiFetch).mockReset().mockImplementation(async (url) => {
      const u = String(url);
      if (!u.includes('reports-budget-tracking')) return ok({});
      if (u.includes('period=ytd')) {
        await new Promise<void>((r) => { releaseYtd = r; });
        return ok(named('Stale YTD line'));
      }
      return ok(named('Fresh FY line'));
    });
    render(<BudgetVsActualPage />);
    await waitFor(() => expect(reportQueries()).toHaveLength(1));
    fireEvent.change(screen.getByTestId('bva-period'), { target: { value: 'fy' } });
    await screen.findByRole('button', { name: /Fresh FY line/ });
    releaseYtd();
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText(/Stale YTD line/)).toBeNull();
    expect(screen.getByRole('button', { name: /Fresh FY line/ })).toBeTruthy();
  });

  it('a load that fails after a good one clears the rows, shows why, and disables the exports', async () => {
    let fail = false;
    vi.mocked(apiFetch).mockReset().mockImplementation(async (url) =>
      (fail && String(url).includes('reports-budget-tracking') ? new Response('', { status: 500 }) : ok(named('Good line'))));
    render(<BudgetVsActualPage />);
    await screen.findByRole('button', { name: /Good line/ });
    const exportCsv = () => screen.getByRole('button', { name: /Export CSV/ }) as HTMLButtonElement;
    const exportXlsx = () => screen.getByRole('button', { name: /Export Excel/ }) as HTMLButtonElement;
    expect([exportCsv().disabled, exportXlsx().disabled]).toEqual([false, false]);
    fail = true;
    fireEvent.change(screen.getByTestId('bva-period'), { target: { value: 'fy' } });
    expect(await screen.findByText('Could not load the budget report - try again')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Good line/ })).toBeNull();
    expect([exportCsv().disabled, exportXlsx().disabled]).toEqual([true, true]);
  });
});

describe('coalescing, refusal and retry (browser review r1)', () => {
  it('three rapid changes make one request, for the last of them', async () => {
    vi.mocked(apiFetch).mockReset().mockImplementation(async () => ok(named('Sales')));
    render(<BudgetVsActualPage />);
    await screen.findByRole('button', { name: /Sales/ });
    fireEvent.change(screen.getByTestId('bva-period'), { target: { value: 'month' } });
    fireEvent.change(screen.getByTestId('bva-month'), { target: { value: '2026-07' } });
    fireEvent.change(screen.getByTestId('bva-month'), { target: { value: '2026-08' } });
    await waitFor(() => expect(reportQueries()).toHaveLength(2));
    await new Promise((r) => setTimeout(r, 600));
    expect(reportQueries()).toEqual([{ period: 'ytd', group_by: 'cc1' }, { period: 'month', month: '2026-08', group_by: 'cc1' }]);
  });

  it("a 429 shows the server's wait and Retry, which re-sends the same request", async () => {
    let refuse = true;
    vi.mocked(apiFetch).mockReset().mockImplementation(async (url) => {
      if (!String(url).includes('reports-budget-tracking')) return ok({});
      return refuse
        ? new Response(JSON.stringify({ success: false, error: { code: 'RATE_LIMIT', message: 'Too many report requests: try again in 4 minutes.' } }), { status: 429, headers: { 'Retry-After': '240' } })
        : ok(named('Back again'));
    });
    render(<BudgetVsActualPage />);
    expect(await screen.findByText('Too many report requests: try again in 4 minutes.')).toBeTruthy();
    refuse = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByRole('button', { name: /Back again/ });
    expect(reportQueries()).toEqual([{ period: 'ytd', group_by: 'cc1' }, { period: 'ytd', group_by: 'cc1' }]);
  });
});

describe("a refusal's wait (review r2, browser N2)", () => {
  const refuseWith = (headers: Record<string, string>) => vi.mocked(apiFetch).mockReset().mockImplementation(async (url) =>
    (String(url).includes('reports-budget-tracking')
      ? new Response(JSON.stringify({ success: false, error: { code: 'RATE_LIMITED', message: 'Too many requests. Please try again shortly.' } }), { status: 429, headers })
      : ok({})));

  it('the shared reports limiter (no Retry-After) reads "about a minute"', async () => {
    refuseWith({});
    render(<BudgetVsActualPage />);
    expect(await screen.findByText('Too many report requests: try again in about a minute.')).toBeTruthy();
  });

  it('a Retry-After is read as the wait', async () => {
    refuseWith({ 'Retry-After': '45' });
    render(<BudgetVsActualPage />);
    expect(await screen.findByText('Too many report requests: try again in 45 seconds.')).toBeTruthy();
  });
});

describe('controls the client can judge (browser review r1)', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('an inverted custom range says so inline and sends no request', async () => {
    vi.mocked(apiFetch).mockReset().mockImplementation(async () => ok(named('Sales')));
    render(<BudgetVsActualPage />);
    await screen.findByRole('button', { name: /Sales/ });
    fireEvent.change(screen.getByTestId('bva-period'), { target: { value: 'custom' } });
    await waitFor(() => expect(reportQueries()).toHaveLength(2));
    fireEvent.change(screen.getByTestId('bva-from'), { target: { value: '2026-09' } });
    fireEvent.change(screen.getByTestId('bva-to'), { target: { value: '2026-05' } });
    expect((await screen.findByTestId('bva-range-error')).textContent).toBe('The From month is after the To month.');
    await new Promise((r) => setTimeout(r, 600));
    expect(reportQueries().filter((q) => q.from === '2026-09')).toEqual([]);
    expect(screen.queryByRole('button', { name: /Sales/ })).toBeNull();
    expect((screen.getByRole('button', { name: /Export CSV/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('Quarter opens on the quarter holding today; a year that does not hold today opens on Q1', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 7, 15, 12));
    vi.mocked(apiFetch).mockReset().mockImplementation(async () => ok(named('Sales')));
    render(<BudgetVsActualPage />);
    await screen.findByRole('button', { name: /Sales/ });
    fireEvent.change(screen.getByTestId('bva-period'), { target: { value: 'quarter' } });
    // FY2027 runs Mar 2026 - Feb 2027: August 2026 is in Q2.
    await waitFor(() => expect(reportQueries().at(-1)).toEqual({ period: 'quarter', quarter: '2', group_by: 'cc1' }));
    fireEvent.change(screen.getByTestId('report-year'), { target: { value: '2026' } });
    await waitFor(() => expect(reportQueries().at(-1)).toEqual({ period: 'quarter', fiscal_year: '2026', quarter: '1', group_by: 'cc1' }));
  });
});

describe('review r2: retry, a late response under an inverted range, the chosen year across periods', () => {
  it('Retry during an active limit sends exactly one request per click, and nothing on its own', async () => {
    vi.mocked(apiFetch).mockReset().mockImplementation(async (url) => (String(url).includes('reports-budget-tracking')
      ? new Response(JSON.stringify({ success: false, error: { message: 'x' } }), { status: 429, headers: { 'Retry-After': '120' } })
      : ok({})));
    render(<BudgetVsActualPage />);
    const retry = await screen.findByRole('button', { name: 'Retry' });
    await new Promise((r) => setTimeout(r, 600));
    expect(reportQueries()).toHaveLength(1);
    for (let i = 2; i <= 4; i++) {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
      await waitFor(() => expect(reportQueries()).toHaveLength(i));
      await screen.findByRole('button', { name: 'Retry' });
    }
    await new Promise((r) => setTimeout(r, 600));
    expect(reportQueries()).toHaveLength(4);
    expect(retry).toBeTruthy();
  });

  it('a response that lands after the range was inverted is dropped, and the exports stay disabled', async () => {
    let release: () => void = () => {};
    vi.mocked(apiFetch).mockReset().mockImplementation(async (url) => {
      const u = String(url);
      if (!u.includes('reports-budget-tracking')) return ok({});
      if (u.includes('period=custom')) { await new Promise<void>((r) => { release = r; }); return ok(named('Late custom line')); }
      return ok(named('Sales'));
    });
    render(<BudgetVsActualPage />);
    await screen.findByRole('button', { name: /Sales/ });
    fireEvent.change(screen.getByTestId('bva-period'), { target: { value: 'custom' } });
    await waitFor(() => expect(reportQueries().some((q) => q.period === 'custom')).toBe(true));
    fireEvent.change(screen.getByTestId('bva-from'), { target: { value: '2026-09' } });
    fireEvent.change(screen.getByTestId('bva-to'), { target: { value: '2026-05' } });
    await screen.findByTestId('bva-range-error');
    release();
    await new Promise((r) => setTimeout(r, 100));
    expect(screen.queryByRole('button', { name: /Late custom line/ })).toBeNull();
    expect((screen.getByRole('button', { name: /Export CSV/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: /Export Excel/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('a chosen financial year carries to every period that takes one, through a period that does not', async () => {
    vi.mocked(apiFetch).mockReset().mockImplementation(async () => ok(named('Sales')));
    render(<BudgetVsActualPage />);
    await screen.findByRole('button', { name: /Sales/ });
    fireEvent.change(screen.getByTestId('bva-period'), { target: { value: 'fy' } });
    fireEvent.change(await screen.findByTestId('report-year'), { target: { value: '2026' } });
    await waitFor(() => expect(reportQueries().at(-1)).toEqual({ period: 'fy', fiscal_year: '2026', group_by: 'cc1' }));
    fireEvent.change(screen.getByTestId('bva-period'), { target: { value: 'month' } });
    await waitFor(() => expect(reportQueries().at(-1)).toEqual({ period: 'month', group_by: 'cc1' }));
    // The month view's URL keeps the year (the request does not send it), so Back or a reload keeps it too.
    await waitFor(() => expect(replaced.at(-1)).toBe('/accounting/reports/budget-vs-actual?period=month&fiscal_year=2026'));
    fireEvent.change(screen.getByTestId('bva-period'), { target: { value: 'ytd' } });
    await waitFor(() => expect(reportQueries().at(-1)).toEqual({ period: 'ytd', fiscal_year: '2026', group_by: 'cc1' }));
  });
});

