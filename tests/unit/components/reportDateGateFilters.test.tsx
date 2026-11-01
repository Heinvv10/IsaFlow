// While a filter date is refused, the report does not run on the previous date behind it: a changed filter waits
// for the date, and the controls that act on the shown period stand down. Pages are in reportDateGatePages.ts.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { apiFetch } from '@/lib/apiFetch';
import { typeDate } from '../helpers/dateFields';
import { GATE_PAGES, gatePage, serve, settle } from '../helpers/reportDateGatePages';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
useApiJsonOverMock();
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
const route = vi.hoisted(() => ({ query: {} as Record<string, string>, isReady: true, push: vi.fn(), pathname: '/' }));
vi.mock('next/router', () => ({ useRouter: () => route }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: 'owner', loading: false, activeCompany: { id: 'c1', vatPeriod: 'monthly', vatSystemType: 'invoice' } }) }));
vi.mock('@/components/accounting/AccountPicker', () => ({ AccountPicker: () => <div /> }));
vi.mock('@/components/accounting/BalanceSheetBody', () => ({ BalanceSheetBody: () => <div>Report body</div> }));
vi.mock('@/components/accounting/reportControls/useStatementComparatorState', () => ({
  useStatementComparatorState: () => ({
    columns: { prior: false, budget: false, trend: false, variance: false }, setColumns: vi.fn(),
    apply: (rows: unknown[]) => rows, budgetState: { status: 'idle' }, companyWideUnavailable: false, trendFailed: false,
  }),
}));

const NOTICE = /Fix the date marked in red/;
const NOT_RUN = 'Fix the date marked in red to run the report.';
const NOTHING_FOUND = /No .* (found|available)/;
const requested = (text: string) => vi.mocked(apiFetch).mock.calls.some(([url]) => String(url).includes(text));
const textbox = (name: string) => screen.getByRole('textbox', { name }) as HTMLInputElement;
const open = async (file: string) => {
  const page = gatePage(file);
  serve(page);
  const { default: Page } = await page.load();
  const view = render(<Page />);
  await waitFor(() => expect(vi.mocked(apiFetch).mock.calls.length).toBeGreaterThan(0));
  await settle();
  return { rerender: () => view.rerender(<Page />) };
};

beforeAll(async () => { await Promise.all(GATE_PAGES.map((p) => p.load())); }, 120_000);
beforeEach(() => { route.query = {}; });
afterEach(cleanup);

const select = () => screen.getAllByRole('combobox')[0] as HTMLSelectElement;
const reports = (path: string) => vi.mocked(apiFetch).mock.calls.filter(([url]) => String(url).includes(path)).length;
describe.each([
  { file: 'account-transactions', date: 'To', control: () => screen.getByTestId('cost-centre-filter'), value: 'cc1', param: 'cost_centre_id=cc1',
    body: 'Opening Balance', path: 'reports-account-transactions', dateParam: 'period_end' },
  { file: 'balance-sheet', date: 'As at', control: select, value: 'cc1', param: 'cost_centre_id=cc1',
    body: 'Report body', path: 'reports-balance-sheet', dateParam: 'as_at_date' },
  { file: 'bank-transactions', date: 'To', control: select, value: '1120', param: 'account_code=1120',
    body: 'Opening Balance', path: 'reports-bank-transactions', dateParam: 'period_end' },
  { file: 'cash-flow', date: 'To', control: select, value: 'C1', param: 'cost_centre=C1',
    body: 'Opening Cash Balance', path: 'reports-cash-flow', dateParam: 'end_date' },
  { file: 'customer-communication', date: 'To', control: select, value: 'failed', param: 'status=failed',
    body: 'a@example.com', path: 'reports/customer-communication', dateParam: 'to' },
  { file: 'journal-entries', date: 'To', control: select, value: 'posted', param: 'status=posted',
    body: 'J1', path: 'reports-journal-entries', dateParam: 'date_to' },
  { file: 'supplier-pos', date: 'To', control: select, value: 'sent', param: 'status=sent',
    body: 'Supplier Total', path: 'reports-supplier-pos', dateParam: 'date_to' },
])('$file', ({ file, date, control, value, param, body, path, dateParam }) => {
  const openWithFilter = async () => {
    await open(file);
    await waitFor(() => expect(control()).toBeTruthy());
    await screen.findAllByRole('option', { name: /One|Savings|Failed|Posted|Sent/ });
    await screen.findByText(body);
    const field = textbox(date);
    const refuse = async () => { typeDate(field, 'zz'); await screen.findByText(NOTICE); };
    return { field, shown: field.value, refuse };
  };

  it('a filter changed over a refused date waits for the date, then runs', async () => {
    const { field, shown, refuse } = await openWithFilter();
    await refuse();
    fireEvent.change(control(), { target: { value } });
    await settle();
    expect(requested(param)).toBe(false);
    typeDate(field, shown);
    await waitFor(() => expect(requested(param)).toBe(true));
  });

  it('retyping the shown date after a refusal neither refetches nor blanks the report', async () => {
    const { field, shown, refuse } = await openWithFilter();
    const before = reports(path);
    await refuse();
    expect(screen.getByText(body)).toBeTruthy();
    typeDate(field, shown);
    await waitFor(() => expect(screen.queryByText(NOTICE)).toBeNull());
    await settle();
    expect(reports(path)).toBe(before);
    expect(screen.getByText(body)).toBeTruthy();
  });

  it('a filter changed over a refused date hides the report, says why, and shows it again if the filter goes back', async () => {
    const { refuse } = await openWithFilter();
    const original = (control() as HTMLSelectElement).value;
    const before = reports(path);
    await refuse();
    fireEvent.change(control(), { target: { value } });
    await waitFor(() => expect(screen.queryByText(body)).toBeNull());
    expect(screen.getByText(NOT_RUN)).toBeTruthy();
    expect(screen.queryByText(NOTHING_FOUND)).toBeNull();
    fireEvent.change(control(), { target: { value: original } });
    await screen.findByText(body);
    expect(screen.queryByText(NOT_RUN)).toBeNull();
    expect(reports(path)).toBe(before);
  });

  it('a load that failed is retried when a refusal ends on the same filters', async () => {
    const { field, shown, refuse } = await openWithFilter();
    const base = vi.mocked(apiFetch).getMockImplementation()!;
    vi.mocked(apiFetch).mockImplementation(async (url, ...rest) => String(url).includes(param)
      ? new Response(JSON.stringify({ success: false, error: { message: 'Refused' } }), { status: 500 }) : base(url, ...rest));
    fireEvent.change(control(), { target: { value } });
    await waitFor(() => expect(requested(param)).toBe(true));
    await waitFor(() => expect(screen.queryByText(body)).toBeNull());
    await settle();
    const before = reports(path);
    await refuse();
    typeDate(field, shown);
    await waitFor(() => expect(reports(path)).toBe(before + 1));
  });

  it('a different valid date typed over a refusal fetches the new range and shows it', async () => {
    const { field, refuse } = await openWithFilter();
    await refuse();
    typeDate(field, '2 Jan 2020');
    await waitFor(() => expect(requested(`${dateParam}=2020-01-02`)).toBe(true));
    await waitFor(() => expect(screen.queryByText(NOTICE)).toBeNull());
    await screen.findByText(body);
  });
});

describe.each([
  { file: 'bank-transactions', value: '1120', param: 'account_code=1120', body: 'Opening Balance',
    late: (d: Record<string, unknown>) => ({ ...d, openingBalance: 777 }), lateText: /777/ },
  { file: 'cash-flow', value: 'C1', param: 'cost_centre=C1', body: 'Opening Cash Balance',
    late: (d: Record<string, unknown>) => ({ ...d, opening_cash: 777 }), lateText: /777/ },
  { file: 'customer-communication', value: 'failed', param: 'status=failed', body: 'a@example.com',
    late: (d: { records: object[] }) => ({ ...d, records: [{ ...d.records[0], email: 'late@example.com' }] }), lateText: /late@example/ },
  { file: 'journal-entries', value: 'posted', param: 'status=posted', body: 'J1',
    late: (d: { entries: object[] }) => ({ ...d, entries: [{ ...d.entries[0], entryNumber: 'LATE' }] }), lateText: /LATE/ },
  { file: 'supplier-pos', value: 'sent', param: 'status=sent', body: 'Supplier Total',
    late: (d: { suppliers: object[] }) => ({ ...d, suppliers: [{ ...d.suppliers[0], supplierName: 'LATE' }] }), lateText: /LATE/ },
] as const)('$file: an old response', ({ file, value, param, body, late, lateText }) => {
  it('does not replace the report of the selection that followed it', async () => {
    await open(file);
    await screen.findAllByRole('option', { name: /Savings|Failed|Posted|Sent|One/ });
    await screen.findByText(body);
    const original = select().value;
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const base = vi.mocked(apiFetch).getMockImplementation()!;
    const data = gatePage(file).data as never;
    vi.mocked(apiFetch).mockImplementation(async (url, ...rest) => {
      if (!String(url).includes(param)) return base(url, ...rest);
      await held;
      return new Response(JSON.stringify({ data: late(data) }), { status: 200 });
    });
    fireEvent.change(select(), { target: { value } });
    await waitFor(() => expect(requested(param)).toBe(true));
    fireEvent.change(select(), { target: { value: original } });
    await screen.findByText(body);
    release();
    await settle();
    expect(screen.queryByText(lateText)).toBeNull();
    expect(screen.getByText(body)).toBeTruthy();
  });
});

it('customer-communication: paging stands down while a date is refused', async () => {
  await open('customer-communication');
  const next = await screen.findByRole('button', { name: 'Next' }) as HTMLButtonElement;
  const shown = textbox('To').value;
  expect(next.disabled).toBe(false);
  typeDate(textbox('To'), 'zz');
  await screen.findByText(NOTICE);
  expect(next.disabled).toBe(true);
  typeDate(textbox('To'), shown);
  await waitFor(() => expect(next.disabled).toBe(false));
});

it('vat-reconciliation: the view that has no dates drops the refusal, and coming back shows the good date', async () => {
  await open('vat-reconciliation');
  const shown = textbox('From').value;
  typeDate(textbox('From'), 'zz');
  await screen.findByText(NOTICE);
  fireEvent.change(select(), { target: { value: 'multi_year' } });
  await waitFor(() => expect(requested('multi_year=3')).toBe(true));
  expect(screen.queryByText(NOTICE)).toBeNull();
  fireEvent.change(select(), { target: { value: 'reconciliation' } });
  await waitFor(() => expect(textbox('From').value).toBe(shown));
});

it('report-packs: Present, Share and the pack types stand down, so nothing leaves on the previous dates', async () => {
  await open('report-packs');
  const board = await screen.findByRole('button', { name: /^Management/ }) as HTMLButtonElement;
  await screen.findByRole('link', { name: /Present/ });
  await screen.findByRole('button', { name: /Share/ });
  const shown = textbox('To').value;
  typeDate(textbox('To'), 'zz');
  await screen.findByText(NOTICE);
  expect(screen.queryByRole('link', { name: /Present/ })).toBeNull();
  expect(screen.queryByRole('button', { name: /Share/ })).toBeNull();
  expect(board.disabled).toBe(true);
  typeDate(textbox('To'), shown);
  await screen.findByRole('link', { name: /Present/ });
  expect(board.disabled).toBe(false);
  expect(screen.getByRole('button', { name: /Share/ })).toBeTruthy();
});

describe('balance-sheet', () => {
  const csv = () => screen.getByRole('button', { name: /Export CSV/ }) as HTMLButtonElement;

  it('Present stands down while the date is refused', async () => {
    await open('balance-sheet');
    await screen.findByRole('link', { name: /Present/ });
    typeDate(textbox('As at'), 'zz');
    await screen.findByText(NOTICE);
    expect(screen.queryByRole('link', { name: /Present/ })).toBeNull();
  });

  it('a route change that keeps the date clears the refused text along with the gate', async () => {
    route.query = { as_at_date: '2026-04-30' };
    const { rerender } = await open('balance-sheet');
    await waitFor(() => expect(csv().disabled).toBe(false));
    typeDate(textbox('As at'), 'zz');
    await screen.findByText(NOTICE);
    route.query = { as_at_date: '2026-04-30', business_unit_id: 'bu1' };
    rerender();
    await waitFor(() => expect(textbox('As at').value).toBe('30 Apr 2026'));
    await waitFor(() => expect(csv().disabled).toBe(false));
    expect(screen.queryByText(NOTICE)).toBeNull();
  });

  it('routing away from a refused date and back does not revive the refusal', async () => {
    route.query = { as_at_date: '2026-04-30' };
    const { rerender } = await open('balance-sheet');
    await waitFor(() => expect(csv().disabled).toBe(false));
    typeDate(textbox('As at'), 'zz');
    await screen.findByText(NOTICE);
    route.query = { as_at_date: '2026-03-31' };
    rerender();
    await waitFor(() => expect(textbox('As at').value).toBe('31 Mar 2026'));
    expect(screen.queryByText(NOTICE)).toBeNull();
    route.query = { as_at_date: '2026-04-30' };
    rerender();
    await waitFor(() => expect(textbox('As at').value).toBe('30 Apr 2026'));
    await settle();
    expect(screen.queryByText(NOTICE)).toBeNull();
  });
});
