// P&L refused dates: what the page does while a From/To shows refused text, and how that refusal ends.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { apiFetch } from '@/lib/apiFetch';
import IncomeStatementPage from '@/../pages/accounting/reports/income-statement';
import type { StatementRow } from '@/modules/accounting/services/reports/statementRows/statementModel';
import { typeDate } from '../helpers/dateFields';
import { localDateFromISO } from '@/lib/dateUtils';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
useApiJsonOverMock();
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
const route = vi.hoisted(() => ({ query: {} as Record<string, string | string[]>, isReady: true, push: vi.fn() }));
vi.mock('next/router', () => ({ useRouter: () => route }));
const comparator = vi.hoisted(() => ({ prior: false }));
vi.mock('@/components/accounting/reportControls/useStatementComparatorState', () => ({
  useStatementComparatorState: () => ({
    columns: { prior: comparator.prior, budget: false, trend: false, variance: false }, setColumns: vi.fn(),
    apply: (rows: StatementRow[]) => rows, budgetState: { status: 'idle' },
    companyWideUnavailable: false, trendFailed: false,
  }),
}));
vi.mock('@/components/accounting/IncomeStatementSections', () => ({ IncomeStatementSections: () => <div /> }));

const report = {
  revenue: [], otherIncome: [], costOfSales: [], operatingExpenses: [], otherExpenses: [],
  totalRevenue: 0, totalOtherIncome: 0, totalCostOfSales: 0, totalOperatingExpenses: 0,
  totalOtherExpenses: 0, grossProfit: 0, operatingProfit: 0, netProfit: 0,
};
const response = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });
const lastParams = () => {
  const urls = vi.mocked(apiFetch).mock.calls.map(([u]) => String(u)).filter((u) => u.includes('reports-income-statement'));
  return new URL(urls.at(-1) ?? '/', 'http://localhost').searchParams;
};

beforeEach(() => {
  comparator.prior = false;
  route.query = { period_start: '2026-04-01', period_end: '2026-04-30' };
  vi.mocked(apiFetch).mockReset().mockImplementation(async (url) => {
    const path = String(url);
    if (path.includes('business-units')) return response([]);
    if (path.includes('cost-centres')) return response({ items: [] });
    if (path.includes('fiscal-periods')) return response(null);
    return response(report);
  });
});
afterEach(cleanup);

/** Let every queued microtask, effect and 0 ms timer run, inside act: after it, nothing already scheduled is pending. */
async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 3; i++) await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

const heading = () => screen.queryByRole('heading', { name: /Profit & Loss —/ });
const reportCalls = () => vi.mocked(apiFetch).mock.calls.filter(([u]) => String(u).includes('reports-income-statement')).length;

it('after refused text, a valid change to the other date never puts a range on the heading the data is not for', async () => {
  render(<IncomeStatementPage />);
  await waitFor(() => expect(heading()?.textContent).toContain('01 Apr 2026 to 30 Apr 2026'));
  typeDate(screen.getByRole('textbox', { name: 'From' }), 'garbage');
  await settle();
  expect(heading()?.textContent).toContain('01 Apr 2026 to 30 Apr 2026');
  typeDate(screen.getByRole('textbox', { name: 'To' }), '15 Apr 2026');
  await settle();
  expect(heading()).toBeNull();
  expect(screen.queryByText(/01 Apr 2026 to 15 Apr 2026/)).toBeNull();
});

it('after refused text, a changed cost centre hides the report instead of re-heading it', async () => {
  const base = vi.mocked(apiFetch).getMockImplementation();
  vi.mocked(apiFetch).mockImplementation(async (url, ...rest) => String(url).includes('cost-centres')
    ? response({ items: [{ id: 'cc1', code: 'C1', name: 'One' }] }) : base!(url, ...rest));
  render(<IncomeStatementPage />);
  await waitFor(() => expect(heading()).not.toBeNull());
  await screen.findByRole('option', { name: /One/ });
  typeDate(screen.getByRole('textbox', { name: 'To' }), 'zz');
  fireEvent.change(screen.getByRole('combobox', { name: 'Cost Centre' }), { target: { value: 'cc1' } });
  await settle();
  expect(heading()).toBeNull();
  expect(screen.getByText('Fix the date to run the report.')).toBeTruthy();
});

it('refused text typed while the load is in flight does not drop the response: the report lands under its own range', async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const base = vi.mocked(apiFetch).getMockImplementation();
  vi.mocked(apiFetch).mockImplementation(async (url, ...rest) => {
    if (String(url).includes('reports-income-statement')) await gate;
    return base!(url, ...rest);
  });
  render(<IncomeStatementPage />);
  await waitFor(() => expect(reportCalls()).toBe(1));
  typeDate(screen.getByRole('textbox', { name: 'To' }), 'zz');
  await settle();
  release();
  await settle();
  expect(heading()?.textContent).toContain('01 Apr 2026 to 30 Apr 2026');
  expect(reportCalls()).toBe(1);
});

it('retyping the shown date after refused text neither refetches nor blanks the report', async () => {
  render(<IncomeStatementPage />);
  await waitFor(() => expect(heading()).not.toBeNull());
  await settle();
  const before = reportCalls();
  typeDate(screen.getByRole('textbox', { name: 'To' }), 'zz');
  await settle();
  typeDate(screen.getByRole('textbox', { name: 'To' }), '30 Apr 2026');
  await settle();
  expect(heading()?.textContent).toContain('01 Apr 2026 to 30 Apr 2026');
  expect(screen.queryByLabelText('Loading profit and loss')).toBeNull();
  expect(reportCalls()).toBe(before);
});

it('an inverted range shows no report heading at all', async () => {
  render(<IncomeStatementPage />);
  await waitFor(() => expect(heading()).not.toBeNull());
  typeDate(screen.getByRole('textbox', { name: 'From' }), '1 Sep 2026');
  await screen.findByText(/From must be on or before To/);
  await settle();
  expect(heading()).toBeNull();
});

it('Present is a link only while a report for valid dates is shown; refused text turns it inert', async () => {
  render(<IncomeStatementPage />);
  await waitFor(() => expect(screen.getByRole('link', { name: /Present/ }).getAttribute('href')).toContain('from=2026-04-01'));
  typeDate(screen.getByRole('textbox', { name: 'To' }), 'zz');
  await waitFor(() => expect(screen.queryByRole('link', { name: /Present/ })).toBeNull());
  expect(screen.getByText('Present').closest('[aria-disabled="true"]')).not.toBeNull();
  typeDate(screen.getByRole('textbox', { name: 'To' }), '30 Apr 2026');
  await waitFor(() => expect(screen.getByRole('link', { name: /Present/ })).toBeTruthy());
});

it('the notice shows for refused text only, not an inverted range (its field already says so)', async () => {
  render(<IncomeStatementPage />);
  await waitFor(() => expect(heading()).not.toBeNull());
  expect(screen.queryByText('Fix the date to run the report.')).toBeNull();
  typeDate(screen.getByRole('textbox', { name: 'From' }), '1 Sep 2026');
  await screen.findByText(/From must be on or before To/);
  await settle();
  expect(screen.queryByText('Fix the date to run the report.')).toBeNull();
  typeDate(screen.getByRole('textbox', { name: 'From' }), 'garbage');
  expect(await screen.findByText('Fix the date to run the report.')).toBeTruthy();
});

it('the notice is one always-mounted status region: empty until refused text leaves no report, and silent for an empty To', async () => {
  render(<IncomeStatementPage />);
  const status = screen.getAllByRole('status').find((el) => el.tagName === 'P' && el.className.includes('text-sm'))!;
  await waitFor(() => expect(heading()).not.toBeNull());
  expect(status.textContent).toBe('');
  typeDate(screen.getByRole('textbox', { name: 'From' }), 'garbage');
  typeDate(screen.getByRole('textbox', { name: 'To' }), '15 Apr 2026');
  await waitFor(() => expect(status.textContent).toBe('Fix the date to run the report.'));
  expect(status.isConnected).toBe(true);
  typeDate(screen.getByRole('textbox', { name: 'From' }), '1 Apr 2026');
  await waitFor(() => expect(status.textContent).toBe(''));
  typeDate(screen.getByRole('textbox', { name: 'To' }), '');
  expect(await screen.findByText('Enter a To date.')).toBeTruthy();
  expect(status.textContent).toBe('');
});


const to = () => screen.getByRole('textbox', { name: 'To' }) as HTMLInputElement;
const csv = () => screen.getByRole('button', { name: /Export CSV/ }) as HTMLButtonElement;
const failPeriodFetch = () => {
  const base = vi.mocked(apiFetch).getMockImplementation();
  vi.mocked(apiFetch).mockImplementation(async (url, ...rest) => {
    if (String(url).includes('fiscal-periods')) throw new Error('offline');
    return base!(url, ...rest);
  });
};

it('a route change to only the business unit clears the refused text along with its gate', async () => {
  const view = render(<IncomeStatementPage />);
  await waitFor(() => expect(csv().disabled).toBe(false));
  typeDate(to(), 'zz');
  await waitFor(() => expect(csv().disabled).toBe(true));
  route.query = { ...route.query, business_unit_id: 'bu1' };
  view.rerender(<IncomeStatementPage />);
  await waitFor(() => expect(lastParams().get('business_unit_id')).toBe('bu1'));
  await waitFor(() => expect(csv().disabled).toBe(false));
  expect(to().value).toBe('30 Apr 2026');
  expect(to().getAttribute('aria-invalid')).toBe('false');
});

it('a route change to a bare URL clears refused text in both dates, even when the open-period fetch fails', async () => {
  failPeriodFetch();
  const view = render(<IncomeStatementPage />);
  await waitFor(() => expect(csv().disabled).toBe(false));
  const from = screen.getByRole('textbox', { name: 'From' }) as HTMLInputElement;
  typeDate(from, 'nope');
  typeDate(to(), 'zz');
  await waitFor(() => expect(csv().disabled).toBe(true));
  route.query = {};
  view.rerender(<IncomeStatementPage />);
  await waitFor(() => expect(csv().disabled).toBe(false));
  expect(from.value).toBe('01 Apr 2026');
  expect(to().value).toBe('30 Apr 2026');
  expect(from.getAttribute('aria-invalid')).toBe('false');
  expect(to().getAttribute('aria-invalid')).toBe('false');
});

it('a URL that names only From leaves the refusal in To, on screen and gating', async () => {
  const view = render(<IncomeStatementPage />);
  await waitFor(() => expect(csv().disabled).toBe(false));
  typeDate(to(), 'zz');
  await waitFor(() => expect(csv().disabled).toBe(true));
  route.query = { period_start: '2026-04-02' };
  view.rerender(<IncomeStatementPage />);
  await settle();
  expect(to().value).toBe('zz');
  expect(to().getAttribute('aria-invalid')).toBe('true');
  expect(csv().disabled).toBe(true);
});

it('the open period landing on a refused To replaces the text and opens the gate, so a good date is not left blocked', async () => {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const base = vi.mocked(apiFetch).getMockImplementation();
  vi.mocked(apiFetch).mockImplementation(async (url, ...rest) => {
    if (!String(url).includes('fiscal-periods')) return base!(url, ...rest);
    await held;
    return response({ startDate: '2026-01-01', endDate: '2026-01-31' });
  });
  route.query = {};
  render(<IncomeStatementPage />);
  await settle();
  typeDate(to(), 'zz');
  await settle();
  release();
  await waitFor(() => expect(to().value).toBe('31 Jan 2026'));
  await waitFor(() => expect(csv().disabled).toBe(false));
});
