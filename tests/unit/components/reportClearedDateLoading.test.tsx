// Clearing a date while a run is in flight starts a run with no query. The run in flight is no longer the latest, so
// it cannot end the loading state: the empty run must, or the page stays on its spinner with nothing coming.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { apiFetch } from '@/lib/apiFetch';
import { typeDate } from '../helpers/dateFields';
import { gatePage, serve, settle } from '../helpers/reportDateGatePages';
import { RANGE_PAGES } from '../helpers/reportRangePages';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
useApiJsonOverMock();
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
const route = vi.hoisted(() => ({ query: {} as Record<string, string>, isReady: true, push: vi.fn(), pathname: '/' }));
vi.mock('next/router', () => ({ useRouter: () => route }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: 'owner', loading: false, activeCompany: { id: 'c1', vatPeriod: 'monthly', vatSystemType: 'invoice' } }) }));
vi.mock('@/components/accounting/AccountPicker', () => ({ AccountPicker: () => <div /> }));
vi.mock('@/components/accounting/BalanceSheetBody', () => ({ BalanceSheetBody: () => <div>Report body</div> }));
vi.mock('@/components/accounting/charts/CashPositionChart', () => ({ CashPositionChart: () => <div /> }));
vi.mock('@/components/accounting/reportControls/useStatementComparatorState', () => ({
  useStatementComparatorState: () => ({
    columns: { prior: false, budget: false, trend: false, variance: false }, setColumns: vi.fn(),
    apply: (rows: unknown[]) => rows, budgetState: { status: 'idle' }, companyWideUnavailable: false, trendFailed: false,
  }),
}));

const year = new Date().getFullYear() + 1;
const DATE = `2 Jan ${year}`;
const ISO = `${year}-01-02`;
const MARKER = 'REPORT-NOW';
const busy = () => document.querySelector('.animate-spin, [data-testid="list-skeleton"]');
const requested = (text: string) => vi.mocked(apiFetch).mock.calls.some(([url]) => String(url).includes(text));
const range = (file: string) => RANGE_PAGES.find((p) => p.file === file)!;

const PAGES = [
  { file: 'balance-sheet', date: 'As at', param: 'as_at_date', body: 'Report body' },
  { file: 'bank-transactions', date: 'To', param: 'period_end', body: 'Opening Balance' },
  { file: 'account-transactions', date: 'To', param: 'period_end', body: 'Opening Balance' },
  ...['audit-trail', 'customer-reports', 'executive-dashboard', 'general-ledger', 'management-accounts', 'project-profitability', 'supplier-reports']
    .map((file) => ({ file, date: 'To', param: range(file).toParam, body: MARKER })),
];

beforeAll(async () => { await Promise.all(PAGES.map((p) => gatePage(p.file).load())); }, 120_000);
beforeEach(() => { route.query = {}; });
afterEach(cleanup);

describe.each(PAGES)('$file', ({ file, date, param, body }) => {
  it('a date cleared with a run in flight ends the loading state, and the late answer changes nothing', async () => {
    const page = gatePage(file);
    serve(page);
    if (body === MARKER) serve({ ...page, data: range(file).data(MARKER) });
    const { default: Page } = await page.load();
    render(<Page />);
    await screen.findByText(body);
    await settle();

    const base = vi.mocked(apiFetch).getMockImplementation()!;
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    vi.mocked(apiFetch).mockImplementation(async (url, ...rest) => {
      if (String(url).includes(`${param}=${ISO}`)) await held;
      return base(url, ...rest);
    });
    const field = screen.getByRole('textbox', { name: date }) as HTMLInputElement;
    typeDate(field, DATE);
    await waitFor(() => expect(requested(`${param}=${ISO}`)).toBe(true));
    await waitFor(() => expect(busy()).toBeTruthy());

    typeDate(field, '');
    await waitFor(() => expect(busy()).toBeNull());
    expect(field.getAttribute('aria-invalid')).toBe('false');
    release();
    await settle();
    expect(busy()).toBeNull();
  });
});
