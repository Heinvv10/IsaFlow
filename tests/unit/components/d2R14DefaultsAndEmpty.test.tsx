// D2 round 14: (1) income statement never defaults to From after To when the open period is in the future;
// (2) group eliminations show no "none found" empty state beside a failed-load banner.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { MSG, ok, on, refuse, serve } from '../helpers/d2R3a6';

const route = vi.hoisted(() => ({ query: {} as Record<string, string>, isReady: true, push: vi.fn(), replace: vi.fn(), pathname: '/' }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/router', () => ({ useRouter: () => route }));
vi.mock('next/link', () => ({ default: ({ children }: { children: ReactNode }) => <a>{children}</a> }));
vi.mock('next/dynamic', () => ({ default: () => () => null }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/accounting/reportControls/useStatementComparatorState', () => ({
  useStatementComparatorState: () => ({ columns: { prior: false, budget: false, trend: false, variance: false }, setColumns: vi.fn(),
    apply: (rows: unknown[]) => rows, budgetState: { status: 'idle' }, companyWideUnavailable: false, trendFailed: false }),
}));

import { apiFetch } from '@/lib/apiFetch';
import { localISODate } from '@/lib/dateUtils';
import IncomeStatementPage from '../../../pages/accounting/reports/income-statement';
import EliminationsPage from '../../../pages/accounting/group/eliminations';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
beforeEach(() => { vi.mocked(apiFetch).mockReset(); route.query = {}; route.isReady = true; });
afterEach(() => { cleanup(); });

const dates = () => Array.from(document.querySelectorAll('input[type="date"]')).map((i) => (i as HTMLInputElement).value);

describe('income statement default dates', () => {
  const today = localISODate();
  const addDays = (d: number) => localISODate(new Date(Date.now() + d * 86400000));
  it('a future-only open period never gives From after To', async () => {
    serve(on('GET', 'reports-income-statement', () => refuse()), on('GET', 'fiscal-periods', () => ok({ id: 'fp', startDate: addDays(200), endDate: addDays(230) })));
    render(<IncomeStatementPage />);
    await waitFor(() => expect(dates().length).toBeGreaterThanOrEqual(2));
    await waitFor(() => { const [from, to] = dates(); expect(from! <= to!).toBe(true); expect(to).toBe(today); });
  });
  it('an open period that has begun is still used (From = its start, To capped to today)', async () => {
    serve(on('GET', 'reports-income-statement', () => refuse()), on('GET', 'fiscal-periods', () => ok({ id: 'fp', startDate: '2020-03-01', endDate: addDays(30) })));
    render(<IncomeStatementPage />);
    await waitFor(() => expect(dates()).toEqual(['2020-03-01', today]));
  });
});

describe('group eliminations load failure', () => {
  const groups = on('GET', 'company-groups', () => ok({ items: [{ id: 'g1', name: 'Group One' }] }));
  it('shows the error and NOT "No elimination adjustments found"', async () => {
    serve(groups, on('GET', 'consolidated-reports', () => refuse()));
    render(<EliminationsPage />);
    expect(await screen.findByText(MSG)).toBeDefined();
    expect(screen.queryByText('No elimination adjustments found')).toBeNull();
  });
  it('a genuinely empty list still says so', async () => {
    serve(groups, on('GET', 'consolidated-reports', () => ok({ items: [] })));
    render(<EliminationsPage />);
    expect(await screen.findByText('No elimination adjustments found')).toBeDefined();
  });
});
