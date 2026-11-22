// A preset pill on a report page: sets the range, drops refused text in the date boxes, lifts the gate on run/export,
// and the run that follows asks for the preset's dates. (Pages and their mocks are shared with reportDateGates.)
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { cleanup, render, screen, waitFor, fireEvent } from '@testing-library/react';
import { apiFetch } from '@/lib/apiFetch';
import { typeDate } from '../helpers/dateFields';
import { gatePage, serve, settle } from '../helpers/reportDateGatePages';
import { formatDisplayDate } from '@/utils/dateFormat';
import { presetRange, asAtPresetDate } from '@/lib/fiscalRangePresets';
import { todayInSast } from '@/lib/saDateParser';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
useApiJsonOverMock();
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
const route = vi.hoisted(() => ({ query: {} as Record<string, string>, isReady: true, push: vi.fn(), pathname: '/' }));
vi.mock('next/router', () => ({ useRouter: () => route }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: 'owner', loading: false, activeCompany: { id: 'c1', financialYearStart: 3 } }) }));
vi.mock('@/components/accounting/AccountPicker', () => ({ AccountPicker: () => <div /> }));
vi.mock('@/components/accounting/BalanceSheetBody', () => ({ BalanceSheetBody: () => <div /> }));
vi.mock('@/components/accounting/reportControls/useStatementComparatorState', () => ({
  useStatementComparatorState: () => ({
    columns: { prior: false, budget: false, trend: false, variance: false }, setColumns: vi.fn(),
    apply: (rows: unknown[]) => rows, budgetState: { status: 'idle' }, companyWideUnavailable: false, trendFailed: false,
  }),
}));

const NOTICE = /Fix the date marked in red/;
const today = () => todayInSast();
const shown = (iso: string) => { const [y, m, d] = iso.split('-').map(Number); return formatDisplayDate(new Date(y, m - 1, d)); };

const CASES = [
  { file: 'general-ledger', pill: 'Last financial year', boxes: { From: () => presetRange('last_fy', today(), 3)!.from, To: () => presetRange('last_fy', today(), 3)!.to } },
  { file: 'ar-aging', pill: 'Last year end', boxes: { 'As at date': () => asAtPresetDate('last_fy_end', today(), 3)! } },
  { file: 'ap-aging', pill: 'Last year end', boxes: { 'As at date': () => asAtPresetDate('last_fy_end', today(), 3)! } },
  { file: 'balance-sheet', pill: 'Last year end', boxes: { 'As at': () => asAtPresetDate('last_fy_end', today(), 3)! } },
];

beforeAll(async () => { await Promise.all(CASES.map((c) => gatePage(c.file).load())); }, 120_000);
beforeEach(() => { route.query = {}; });
afterEach(cleanup);

describe.each(CASES)('$file preset pick', ({ file, pill, boxes }) => {
  it('fetches the preset range; picking it over refused text drops that text and lifts the gate', async () => {
    const page = gatePage(file);
    serve(page);
    const { default: Page } = await page.load();
    render(<Page />);
    if (page.prepare) await page.prepare();
    else await waitFor(() => expect(vi.mocked(apiFetch).mock.calls.length).toBeGreaterThan(0));
    await settle();
    const first = Object.keys(boxes)[0];
    const field = screen.getByRole('textbox', { name: first }) as HTMLInputElement;
    const pillBtn = () => screen.getByRole('button', { name: pill }) as HTMLButtonElement;
    await waitFor(() => expect(pillBtn().disabled).toBe(false));
    // Pick once so the page already holds the preset's dates, then refuse text: picking it again changes no date,
    // so only the page's gate reset can drop the refused text.
    const before = vi.mocked(apiFetch).mock.calls.length;
    fireEvent.click(pillBtn());
    await settle();
    await waitFor(() => expect(vi.mocked(apiFetch).mock.calls.length).toBeGreaterThan(before));
    const urls = vi.mocked(apiFetch).mock.calls.slice(before).map((c) => String(c[0]));
    for (const iso of Object.values(boxes)) expect(urls.some((u) => u.includes(iso()))).toBe(true);
    typeDate(field, 'zz');
    expect(await screen.findByText(NOTICE)).toBeTruthy();
    await settle();
    fireEvent.click(pillBtn());
    await settle();

    expect(screen.queryByText(NOTICE)).toBeNull();
    for (const [label, iso] of Object.entries(boxes)) {
      expect((screen.getByRole('textbox', { name: label }) as HTMLInputElement).value).toBe(shown(iso()));
    }
    for (const name of page.actions) await waitFor(() => expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(false));
    expect(pillBtn().getAttribute('aria-pressed')).toBe('true');
  });
});
