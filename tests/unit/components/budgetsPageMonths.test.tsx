/**
 * The budgets page builds one column and one input per CALENDAR MONTH of the
 * selected financial year, so a 14-month transition year shows 14 of each, and
 * what it saves is exactly those months.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { formatCents } from '@/lib/money/formatMoney';
import { apiFetch } from '@/lib/apiFetch';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { ok, script } from '../helpers/d2R3a5';

configure({ asyncUtilTimeout: 4000 });
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, isReady: true, push: vi.fn() }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));

import BudgetsPage from '../../../pages/accounting/budgets/index';
import { clickAddBudget, YEAR_2027 } from './budgetsApiFixture';

useApiJsonOverMock();
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const KEYS = ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07',
  '2026-08', '2026-09', '2026-10', '2026-11', '2026-12', '2027-01', '2027-02'];
const TRANSITION = { fiscalYear: 2026, startDate: '2026-01-01', endDate: '2027-02-28', kind: 'transition', monthKeys: KEYS };
const NEXT = { ...YEAR_2027, fiscalYear: 2028, startDate: '2027-03-01', endDate: '2028-02-29', monthKeys: ['2027-03', '2027-04', '2027-05', '2027-06', '2027-07', '2027-08', '2027-09', '2027-10', '2027-11', '2027-12', '2028-01', '2028-02'] };
const GL = [{ id: 'g0', accountCode: '4000', accountName: 'Sales', accountType: 'revenue', isActive: true },
  { id: 'g1', accountCode: '5000', accountName: 'Rent', accountType: 'expense', isActive: true }];
const SALES = {
  id: 'b1', glAccountId: 'g0', accountCode: '4000', accountName: 'Sales', accountType: 'revenue', fiscalYear: 2026,
  annualAmount: 10500, months: KEYS.map((month, i) => ({ month, amount: (i + 1) * 100 })), notes: 'n',
};

const budgetsBody = (items: unknown[]) => ({ items, fiscalYear: 2026, year: TRANSITION, monthKeys: KEYS, years: [TRANSITION, NEXT] });
function serve(items: unknown[]) {
  script((u) => {
    if (u.includes('chart-of-accounts')) return ok(GL);
    if (/\/budgets(\?|$)/.test(u)) return ok(budgetsBody(items));
    return undefined;
  });
}
/**
 * `serve`, with the budgets GET answered only after `ms`: the page's first load
 * is still in flight when the test looks for Add Budget, as it is on a loaded box.
 */
function serveSlowly(items: unknown[], ms: number) {
  vi.mocked(apiFetch).mockReset().mockImplementation(async (url) => {
    const u = String(url);
    if (u.includes('chart-of-accounts')) return ok(GL);
    if (/\/budgets(\?|$)/.test(u)) {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return ok(budgetsBody(items));
    }
    return ok({});
  });
}
const posted = (urlPart: string) => {
  const call = vi.mocked(apiFetch).mock.calls.find(([u, init]) => String(u).includes(urlPart) && init?.method === 'POST');
  return call ? JSON.parse(String((call[1] as RequestInit).body)) : undefined;
};
const input = (key: string) => within(screen.getByTestId(`budget-month-${key}`)).getByRole('textbox') as HTMLInputElement;
const annual = () => screen.getByLabelText(/Annual amount/) as HTMLInputElement;
/** What a MoneyField shows for `cents` once committed. */
const shown = (cents: number) => formatCents(cents, { symbol: false });
/** Type `text` and leave the field: MoneyField parses on blur. */
function enter(el: HTMLInputElement, text: string) {
  fireEvent.change(el, { target: { value: text } });
  fireEvent.blur(el);
}

describe('budgets page, 14-month transition year', () => {
  it('shows the year with its range and 14 month columns, with the row total', async () => {
    serve([SALES]);
    render(<BudgetsPage />);
    await screen.findByText('Sales');
    const select = screen.getByTestId('budget-year') as HTMLSelectElement;
    expect(select.value).toBe('2026');
    expect(Array.from(select.options).map(o => o.text)).toEqual([
      '2026: Jan 2026 - Feb 2027 (14 months)', '2028: Mar 2027 - Feb 2028 (12 months)']);
    expect(screen.getByText(/transition year/)).toBeTruthy();
    expect(screen.getAllByRole('columnheader').map(h => h.textContent).filter(t => /^[A-Z][a-z]{2} \d{4}$/.test(t ?? '')))
      .toHaveLength(14);
    expect(screen.getByTestId('budget-total-4000').textContent).toMatch(/10\D?500/);
  });

  it('add: 14 month inputs; the annual amount spreads over them and what is saved is exactly those 14 months', async () => {
    serveSlowly([], 300);
    render(<BudgetsPage />);
    await clickAddBudget();
    await screen.findByRole('option', { name: /Rent/ });
    expect(KEYS.map(k => input(k).value)).toEqual(Array(14).fill(''));
    fireEvent.change(screen.getByText('Select GL Account *').closest('select')!, { target: { value: 'g1' } });
    enter(annual(), '14000');
    expect(KEYS.map(k => input(k).value)).toEqual(Array(14).fill(shown(100000)));
    enter(input('2027-02'), '1500');
    expect(annual().value).toBe(shown(1450000));

    fireEvent.submit(screen.getByTestId('budget-save').closest('form')!);
    await waitFor(() => expect(posted('/api/accounting/budgets')).toBeDefined());
    const body = posted('/api/accounting/budgets');
    expect(body).toMatchObject({ glAccountId: 'g1', fiscalYear: 2026, annualAmount: 14500 });
    expect(body.months).toEqual(KEYS.map(month => ({ month, amount: month === '2027-02' ? 1500 : 1000 })));
  });

  it('edit starts from the stored months and keeps the account fixed', async () => {
    serve([SALES]);
    render(<BudgetsPage />);
    await screen.findByText('Sales');
    fireEvent.click(screen.getByTitle('Edit'));
    expect(KEYS.map(k => input(k).value)).toEqual(KEYS.map((_, i) => shown((i + 1) * 10000)));
    expect((screen.getByText('4000 — Sales').closest('select') as HTMLSelectElement).disabled).toBe(true);
    enter(input('2026-01'), '0');
    expect(annual().value).toBe(shown(1040000));
  });

  it('delete names the account and the year, and copy targets the next listed year (label 2027 does not exist)', async () => {
    serve([SALES]);
    render(<BudgetsPage />);
    await screen.findByText('Sales');
    fireEvent.click(screen.getByTitle('Delete'));
    fireEvent.click(await screen.findByText('Delete')); // delete asks first
    await waitFor(() => expect(posted('budgets-action')).toBeDefined());
    expect(posted('budgets-action')).toEqual({ action: 'delete', glAccountId: 'g0', fiscalYear: 2026 });
    cleanup();

    vi.mocked(apiFetch).mockClear();
    serve([SALES]);
    render(<BudgetsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /copy to 2028/i }));
    await waitFor(() => expect(posted('budgets-action')).toBeDefined());
    expect(posted('budgets-action')).toEqual({ action: 'copy', fromYear: 2026, toYear: 2028 });
  });
});
