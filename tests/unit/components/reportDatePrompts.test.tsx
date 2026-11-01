// Three honest messages around a refused or cleared report date:
//  1. a form submitted over a refused date says so (it used to return silently with the button enabled),
//  2. an old load error does not sit beside "Fix the date marked in red to run the report.",
//  3. a cleared date asks for a date instead of showing the empty-data text of a period with no data.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { apiFetch } from '@/lib/apiFetch';
import { typeDate } from '../helpers/dateFields';
import { gatePage, serve, settle } from '../helpers/reportDateGatePages';
import { RANGE_PAGES } from '../helpers/reportRangePages';
import { ok } from '../helpers/d2CensusG4';
import VatAdjustments from '../../../pages/accounting/vat-adjustments/index';
import ItemAdjustments from '../../../pages/accounting/item-adjustments';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
useApiJsonOverMock();
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
const route = vi.hoisted(() => ({ query: {} as Record<string, string>, isReady: true, push: vi.fn(), replace: vi.fn(), pathname: '/' }));
vi.mock('next/router', () => ({ useRouter: () => route }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: 'owner', loading: false, activeCompany: { id: 'c1', name: 'Co', vatPeriod: 'monthly', vatSystemType: 'invoice' } }) }));
vi.mock('@/components/accounting/charts/CashPositionChart', () => ({ CashPositionChart: () => <div /> }));

const FIX_BEFORE_SAVING = 'Fix the date marked in red before saving.';
const NOT_RUN = 'Fix the date marked in red to run the report.';
const NOW = 'REPORT-NOW';
const EMPTY = /No data for period|No entries for period|No project financial activity|No transactions/;
const FAILURE = JSON.stringify({ success: false, error: { message: 'Refused by the server' } });
const textbox = (name: string) => screen.getByRole('textbox', { name }) as HTMLInputElement;
const posts = () => vi.mocked(apiFetch).mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST');

beforeEach(() => { route.query = {}; });
afterEach(cleanup);

describe.each([
  { name: 'vat-adjustments', Page: VatAdjustments, label: /^Adjustment Date/, list: 'vat-adjustments' },
  { name: 'item-adjustments', Page: ItemAdjustments, label: /^Date/, list: 'item-adjustments' },
])('$name submit over a refused date', ({ Page, label, list }) => {
  it('says why nothing was saved, and posts nothing', async () => {
    vi.mocked(apiFetch).mockReset().mockImplementation(async (url) => ok(list === 'vat-adjustments' && String(url).includes(list) ? { items: [] } : []));
    render(<Page />);
    fireEvent.click(await screen.findByRole('button', { name: /new adjustment/i }));
    const field = screen.getByRole('textbox', { name: label });
    typeDate(field, '5 Oct 2031');
    typeDate(field, 'zz');
    fireEvent.submit(field.closest('form')!);
    expect(await screen.findByText(FIX_BEFORE_SAVING)).toBeTruthy();
    expect(posts()).toHaveLength(0);
  });
});

const PAGES = ['audit-trail', 'bank-transactions', 'customer-reports', 'supplier-reports', 'project-profitability', 'management-accounts'];
const bankData = { accountCode: '1110', accountName: 'Bank', openingBalance: 0, closingBalance: 0, transactions: [] };
const rangeOf = (file: string) => RANGE_PAGES.find((p) => p.file === file);
const reportPath = (file: string) => (file === 'bank-transactions' ? 'reports-bank-transactions' : rangeOf(file)!.paths[0]);
const dataOf = (file: string) => (file === 'bank-transactions' ? bankData : rangeOf(file)!.data(NOW));
const shown = (file: string) => (file === 'bank-transactions' ? 'Opening Balance' : NOW);

beforeAll(async () => { await Promise.all(PAGES.map((f) => gatePage(f).load())); }, 120_000);

async function open(file: string) {
  const page = gatePage(file);
  serve({ ...page, data: dataOf(file) });
  const { default: Page } = await page.load();
  render(<Page />);
  await screen.findByText(shown(file));
  await settle();
}

describe.each(PAGES)('%s report dates', (file) => {
  it('an old load error is not shown beside "Fix the date ... to run the report."', async () => {
    await open(file);
    const base = vi.mocked(apiFetch).getMockImplementation()!;
    vi.mocked(apiFetch).mockImplementation(async (url, ...rest) => String(url).includes(reportPath(file))
      ? new Response(FAILURE, { status: 500 }) : base(url, ...rest));
    typeDate(textbox('To'), '5 Oct 2031');
    await screen.findByText(/Refused by the server/);

    typeDate(textbox('From'), 'zz');
    typeDate(textbox('To'), '6 Oct 2031');
    await screen.findByText(NOT_RUN);
    expect(screen.queryByText(/Refused by the server/)).toBeNull();
  });

  it('a cleared date asks for a date, not "no data"', async () => {
    await open(file);
    expect(screen.queryByTestId('enter-date-notice')).toBeNull();
    typeDate(textbox('To'), '');
    await screen.findByTestId('enter-date-notice');
    expect(screen.queryByText(EMPTY)).toBeNull();
    expect(screen.queryByText(shown(file))).toBeNull();

    typeDate(textbox('To'), '6 Oct 2031');
    await waitFor(() => expect(screen.queryByTestId('enter-date-notice')).toBeNull());
    await screen.findByText(shown(file));
  });
});
