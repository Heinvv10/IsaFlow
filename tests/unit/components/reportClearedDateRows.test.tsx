// Clearing a date leaves the page with no query to run. The rows of the last run were for other dates, so they go:
// the empty run clears them, as it does on account-transactions and general-ledger.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
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

const MARKER = 'REPORT-NOW';
const range = (file: string) => RANGE_PAGES.find((p) => p.file === file)!;

const PAGES = [
  { file: 'balance-sheet', date: 'As at', body: 'Report body' },
  { file: 'bank-transactions', date: 'To', body: 'Opening Balance' },
  { file: 'account-transactions', date: 'To', body: 'Opening Balance' },
  ...['audit-trail', 'customer-reports', 'general-ledger', 'management-accounts', 'project-profitability', 'supplier-reports']
    .map((file) => ({ file, date: 'To', body: MARKER })),
];

beforeAll(async () => { await Promise.all(PAGES.map((p) => gatePage(p.file).load())); }, 120_000);
beforeEach(() => { route.query = {}; });
afterEach(cleanup);

describe.each(PAGES)('$file', ({ file, date, body }) => {
  it('a cleared date takes the old report off the screen', async () => {
    const page = gatePage(file);
    serve(page);
    if (body === MARKER) serve({ ...page, data: range(file).data(MARKER) });
    const { default: Page } = await page.load();
    render(<Page />);
    await screen.findByText(body);
    await settle();

    typeDate(screen.getByRole('textbox', { name: date }), '');
    await waitFor(() => expect(screen.queryByText(body)).toBeNull());
  });
});
