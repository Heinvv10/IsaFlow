/** Rapid year switches on the budgets page: a late answer for a year the user has left never replaces the year on screen. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, configure, fireEvent, render, screen } from '@testing-library/react';
import { apiFetch } from '@/lib/apiFetch';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { empty500, ok } from '../helpers/d2R3a5';

configure({ asyncUtilTimeout: 4000 });
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, isReady: true, push: vi.fn() }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));

import BudgetsPage from '../../../pages/accounting/budgets/index';
import { YEAR_2027, budgetRow, budgetsPayload } from './budgetsApiFixture';

useApiJsonOverMock();
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

type Deferred = { url: string; resolve: (r: Response) => void };

/** The page loaded on FY2026, then the user picked 2027 and straight back to 2026: two requests in flight. */
async function switchTwice() {
  const pending: Deferred[] = [];
  vi.mocked(apiFetch).mockReset().mockImplementation((url) => {
    const u = String(url);
    if (u.includes('chart-of-accounts')) return Promise.resolve(ok([]));
    if (/\/budgets(\?|$)/.test(u)) return new Promise<Response>((resolve) => { pending.push({ url: u, resolve }); });
    return Promise.resolve(ok({}));
  });
  const answer = (year: string, payload: unknown) =>
    act(async () => {
      pending.find((p) => p.url.endsWith(year === '' ? '/api/accounting/budgets' : `?fiscal_year=${year}`))!.resolve(payload instanceof Response ? payload : ok(payload));
    });

  render(<BudgetsPage />);
  await answer('', budgetsPayload([budgetRow({ accountName: 'Sales for 2026' })]));
  await screen.findByText('Sales for 2026');
  const select = screen.getByTestId('budget-year') as HTMLSelectElement;
  fireEvent.change(select, { target: { value: '2027' } });
  fireEvent.change(select, { target: { value: '2026' } });
  const latest = budgetsPayload([budgetRow({ accountName: 'Sales again 2026' })]);
  const stale = budgetsPayload([budgetRow({ accountName: 'Sales for 2027', fiscalYear: 2027 })], YEAR_2027);
  return { answer, latest, stale };
}

describe('budgets page year switching', () => {
  it('a slow answer for an earlier choice, arriving last, does not replace the latest one', async () => {
    const { answer, latest, stale } = await switchTwice();
    await answer('2026', latest);
    await screen.findByText('Sales again 2026');
    await answer('2027', stale);
    expect(screen.queryByText('Sales for 2027')).toBeNull();
    expect(screen.getByText('Sales again 2026')).toBeTruthy();
    expect((screen.getByTestId('budget-year') as HTMLSelectElement).value).toBe('2026');
  });

  it('an earlier choice answering first neither shows nor ends the loading of the latest one', async () => {
    const { answer, latest, stale } = await switchTwice();
    await answer('2027', stale);
    expect(screen.queryByText('Sales for 2027')).toBeNull();
    expect(screen.getByText('Loading...')).toBeTruthy();
    await answer('2026', latest);
    await screen.findByText('Sales again 2026');
    expect(screen.queryByText('Loading...')).toBeNull();
  });

  it('an earlier choice that fails, arriving last, shows no error and keeps the latest rows', async () => {
    const { answer, latest } = await switchTwice();
    await answer('2026', latest);
    await screen.findByText('Sales again 2026');
    await answer('2027', empty500());
    expect(screen.queryByText(/Could not load budgets/)).toBeNull();
    expect(screen.getByText('Sales again 2026')).toBeTruthy();
  });
});

describe('budgets page first load', () => {
  it('asks for the current year with no fiscal_year parameter at all', async () => {
    vi.mocked(apiFetch).mockReset().mockImplementation(async (url) =>
      ok(String(url).includes('chart-of-accounts') ? [] : budgetsPayload([budgetRow()])));
    render(<BudgetsPage />);
    await screen.findByText('D2 Sales Budget');
    const urls = vi.mocked(apiFetch).mock.calls.map(([u]) => String(u)).filter((u) => /\/budgets(\?|$)/.test(u));
    expect(urls).toEqual(['/api/accounting/budgets']);
  });
});
