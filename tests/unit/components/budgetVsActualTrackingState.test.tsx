/**
 * Budgets P3 PR-B review r1: the Budget vs Actual page's state.
 * - L5: the controls live in the page URL. A URL's controls are the first
 *   request; a change is written back (shallow replace), so Back and a shared
 *   link reopen the same report.
 * - M4: a response that arrives after a newer request is dropped, so a slow
 *   earlier window never replaces a later one; a load that fails after a good
 *   one clears the report: no rows, the error, and the exports disabled.
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
