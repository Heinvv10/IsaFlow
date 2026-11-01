// P&L filters (wave 2 L): To's "eom" counts from From, and the cost-centre and business-unit selects are
// named by their labels.
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

it('"1 Sep 2026" in From and "eom" in To request 1 to 30 Sep 2026', async () => {
  render(<IncomeStatementPage />);
  await waitFor(() => expect(lastParams().get('period_end')).toBe('2026-04-30'));
  typeDate(screen.getByRole('textbox', { name: 'From' }), '1 Sep 2026');
  typeDate(screen.getByRole('textbox', { name: 'To' }), 'eom');
  await waitFor(() => expect(lastParams().get('period_end')).toBe('2026-09-30'));
  expect(lastParams().get('period_start')).toBe('2026-09-01');
});

it('the cost-centre and business-unit selects are named by their labels', () => {
  render(<IncomeStatementPage />);
  expect(screen.getByRole('combobox', { name: 'Cost Centre' }).tagName).toBe('SELECT');
  expect(screen.getByRole('combobox', { name: 'Business Unit' }).tagName).toBe('SELECT');
});

it('To may not be before From: "-7" from 1 Apr is refused, and no report is requested for it', async () => {
  render(<IncomeStatementPage />);
  await waitFor(() => expect(lastParams().get('period_end')).toBe('2026-04-30'));
  typeDate(screen.getByRole('textbox', { name: 'To' }), '-7');
  expect(await screen.findByText(/on or after 01 Apr 2026/)).toBeTruthy();
  expect(lastParams().get('period_end')).toBe('2026-04-30');
});

it('refused text in To keeps the last good report and its heading, fires no request, and cannot be exported; a valid date resumes', async () => {
  render(<IncomeStatementPage />);
  const csv = () => screen.getByRole('button', { name: /Export CSV/ }) as HTMLButtonElement;
  const xlsx = () => screen.getByRole('button', { name: /Export (XLSX|Excel)/ }) as HTMLButtonElement;
  await waitFor(() => expect(csv().disabled).toBe(false));
  await settle();
  expect(screen.getByRole('heading', { name: /Profit & Loss — 01 Apr 2026 to 30 Apr 2026/ })).toBeTruthy();
  const before = vi.mocked(apiFetch).mock.calls.length;
  typeDate(screen.getByRole('textbox', { name: 'To' }), 'zz');
  await waitFor(() => expect(csv().disabled).toBe(true));
  await settle();
  expect(xlsx().disabled).toBe(true);
  expect(screen.getByRole('heading', { name: /Profit & Loss — 01 Apr 2026 to 30 Apr 2026/ })).toBeTruthy();
  expect(vi.mocked(apiFetch).mock.calls.length).toBe(before);
  typeDate(screen.getByRole('textbox', { name: 'To' }), '15 Apr 2026');
  await waitFor(() => expect(csv().disabled).toBe(false));
  expect(lastParams().get('period_end')).toBe('2026-04-15');
});

it('valid dates from a client-side route change clear a refused date and load the new report', async () => {
  const view = render(<IncomeStatementPage />);
  const csv = () => screen.getByRole('button', { name: /Export CSV/ }) as HTMLButtonElement;
  await waitFor(() => expect(csv().disabled).toBe(false));
  typeDate(screen.getByRole('textbox', { name: 'To' }), 'zz');
  await waitFor(() => expect(csv().disabled).toBe(true));

  route.query = { period_start: '2026-05-01', period_end: '2026-05-31' };
  view.rerender(<IncomeStatementPage />);

  await waitFor(() => expect(lastParams().get('period_end')).toBe('2026-05-31'));
  expect(lastParams().get('period_start')).toBe('2026-05-01');
  expect(csv().disabled).toBe(false);
});

it.each([
  ['an impossible date', '2026-02-30', '2026-03-31'],
  ['text', 'foo', '2026-03-31'],
  ['a bad To', '2026-03-01', 'bar'],
  ['a non-padded date', '2026-3-1', '2026-3-31'],
])('a deep link with %s in the URL renders the page on the default dates instead of crashing', async (_name, start, end) => {
  route.query = { period_start: start, period_end: end };
  render(<IncomeStatementPage />);
  const from = screen.getByRole('textbox', { name: 'From' }) as HTMLInputElement;
  const to = screen.getByRole('textbox', { name: 'To' }) as HTMLInputElement;
  expect(from.value).toMatch(/^\d{2} \w{3} \d{4}$/);
  expect(to.value).toMatch(/^\d{2} \w{3} \d{4}$/);
  await waitFor(() => expect(lastParams().get('period_start')).toMatch(/^\d{4}-\d{2}-\d{2}$/));
  const asked = vi.mocked(apiFetch).mock.calls.map(([u]) => String(u)).filter((u) => u.includes('reports-income-statement'));
  for (const u of asked) {
    const q = new URL(u, 'http://localhost').searchParams;
    expect(localDateFromISO(q.get('period_start') ?? '')).not.toBeNull();
    expect(localDateFromISO(q.get('period_end') ?? '')).not.toBeNull();
  }
});

it('From typed after To is refused on screen and no inverted range is requested; fixing To brings the report back', async () => {
  render(<IncomeStatementPage />);
  await waitFor(() => expect(lastParams().get('period_end')).toBe('2026-04-30'));
  const csv = () => screen.getByRole('button', { name: /Export CSV/ }) as HTMLButtonElement;
  await waitFor(() => expect(csv().disabled).toBe(false));
  typeDate(screen.getByRole('textbox', { name: 'From' }), '1 Sep 2026');
  expect(await screen.findByText(/From must be on or before To/)).toBeTruthy();
  await waitFor(() => expect(csv().disabled).toBe(true));
  const ranges = () => vi.mocked(apiFetch).mock.calls
    .map(([u]) => String(u)).filter((u) => u.includes('reports-income-statement'))
    .map((u) => new URL(u, 'http://localhost').searchParams);
  expect(ranges().every((p) => (p.get('period_start') ?? '') <= (p.get('period_end') ?? ''))).toBe(true);
  typeDate(screen.getByRole('textbox', { name: 'To' }), 'eom');
  await waitFor(() => expect(csv().disabled).toBe(false));
  expect(lastParams().get('period_start')).toBe('2026-09-01');
  expect(lastParams().get('period_end')).toBe('2026-09-30');
  expect(screen.queryByText(/From must be on or before To/)).toBeNull();
});

it('clearing To blocks the run and says so on To, not on From', async () => {
  render(<IncomeStatementPage />);
  const csv = () => screen.getByRole('button', { name: /Export CSV/ }) as HTMLButtonElement;
  await waitFor(() => expect(csv().disabled).toBe(false));
  const calls = () => vi.mocked(apiFetch).mock.calls.length;
  await settle();
  const before = calls();
  typeDate(screen.getByRole('textbox', { name: 'To' }), '');
  expect(await screen.findByText('Enter a To date.')).toBeTruthy();
  expect(screen.queryByText(/From must be on or before To/)).toBeNull();
  await waitFor(() => expect(csv().disabled).toBe(true));
  await settle();
  expect(calls()).toBe(before);
  expect(screen.queryByText(/Profit & Loss —/)).toBeNull();
  typeDate(screen.getByRole('textbox', { name: 'To' }), '30 Apr 2026');
  await waitFor(() => expect(csv().disabled).toBe(false));
  expect(screen.queryByText('Enter a To date.')).toBeNull();
});

it('refused text in From shows its own reason, not the inverted-range message that was on screen', async () => {
  render(<IncomeStatementPage />);
  await waitFor(() => expect(lastParams().get('period_end')).toBe('2026-04-30'));
  typeDate(screen.getByRole('textbox', { name: 'From' }), '1 Sep 2026');
  expect(await screen.findByText(/From must be on or before To/)).toBeTruthy();
  typeDate(screen.getByRole('textbox', { name: 'From' }), 'garbage');
  await waitFor(() => expect(screen.queryByText(/From must be on or before To/)).toBeNull());
  const from = screen.getByRole('textbox', { name: 'From' });
  const described = (from.getAttribute('aria-describedby') ?? '').split(' ').map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
  expect(from.getAttribute('aria-invalid')).toBe('true');
  expect(described).toMatch(/\S/);
  expect(described).not.toMatch(/on or before To/);
});

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

it('with Prior period on, the request carries the matching compare_start and compare_end', async () => {
  comparator.prior = true;
  render(<IncomeStatementPage />);
  await waitFor(() => expect(lastParams().get('compare_end')).toBe('2026-03-31'));
  expect(lastParams().get('compare_start')).toBe('2026-03-02');
});
