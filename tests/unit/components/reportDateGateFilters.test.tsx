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
vi.mock('@/components/accounting/BalanceSheetBody', () => ({ BalanceSheetBody: () => <div /> }));
vi.mock('@/components/accounting/reportControls/useStatementComparatorState', () => ({
  useStatementComparatorState: () => ({
    columns: { prior: false, budget: false, trend: false, variance: false }, setColumns: vi.fn(),
    apply: (rows: unknown[]) => rows, budgetState: { status: 'idle' }, companyWideUnavailable: false, trendFailed: false,
  }),
}));

const NOTICE = /Fix the date marked in red/;
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
describe.each([
  { file: 'account-transactions', date: 'To', control: () => screen.getByTestId('cost-centre-filter'), value: 'cc1', param: 'cost_centre_id=cc1' },
  { file: 'balance-sheet', date: 'As at', control: select, value: 'cc1', param: 'cost_centre_id=cc1' },
  { file: 'bank-transactions', date: 'To', control: select, value: '1120', param: 'account_code=1120' },
  { file: 'cash-flow', date: 'To', control: select, value: 'C1', param: 'cost_centre=C1' },
  { file: 'customer-communication', date: 'To', control: select, value: 'failed', param: 'status=failed' },
  { file: 'journal-entries', date: 'To', control: select, value: 'posted', param: 'status=posted' },
  { file: 'supplier-pos', date: 'To', control: select, value: 'sent', param: 'status=sent' },
])('$file', ({ file, date, control, value, param }) => {
  it('a filter changed over a refused date waits for the date, then runs', async () => {
    await open(file);
    await waitFor(() => expect(control()).toBeTruthy());
    await screen.findAllByRole('option', { name: /One|Savings|Failed|Posted|Sent/ });
    const field = textbox(date);
    const shown = field.value;
    typeDate(field, 'zz');
    await screen.findByText(NOTICE);
    fireEvent.change(control(), { target: { value } });
    await settle();
    expect(requested(param)).toBe(false);
    typeDate(field, shown);
    await waitFor(() => expect(requested(param)).toBe(true));
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
