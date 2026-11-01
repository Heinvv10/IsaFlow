// Every report page: refused text in a filter date says so and stops the page's run and export actions, on
// screen, with no request sent; retyping a good date gives them back. Pages are in reportDateGatePages.ts.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { apiFetch } from '@/lib/apiFetch';
import { typeDate } from '../helpers/dateFields';
import { GATE_PAGES, serve, settle } from '../helpers/reportDateGatePages';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
useApiJsonOverMock();
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
const route = vi.hoisted(() => ({ query: {} as Record<string, string>, isReady: true, push: vi.fn(), pathname: '/' }));
vi.mock('next/router', () => ({ useRouter: () => route }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: 'owner', loading: false, activeCompany: { id: 'c1', vatPeriod: 'monthly', vatSystemType: 'invoice' } }) }));
vi.mock('@/components/accounting/AccountPicker', () => ({ AccountPicker: () => <div /> }));
vi.mock('@/components/accounting/supplier-invoices/SupplierSelect', () => ({
  SupplierSelect: ({ onChange }: { onChange: (id: string, name: string) => void }) => <button type="button" onClick={() => onChange('s1', 'A')}>Pick supplier</button>,
}));
vi.mock('@/components/accounting/BalanceSheetBody', () => ({ BalanceSheetBody: () => <div /> }));
vi.mock('@/components/accounting/reportControls/useStatementComparatorState', () => ({
  useStatementComparatorState: () => ({
    columns: { prior: false, budget: false, trend: false, variance: false }, setColumns: vi.fn(),
    apply: (rows: unknown[]) => rows, budgetState: { status: 'idle' }, companyWideUnavailable: false, trendFailed: false,
  }),
}));

const button = (name: RegExp) => screen.getByRole('button', { name }) as HTMLButtonElement;
const NOTICE = /Fix the date marked in red/;

beforeAll(async () => { await Promise.all(GATE_PAGES.map((p) => p.load())); }, 120_000);
beforeEach(() => { route.query = {}; });
afterEach(cleanup);

describe.each(GATE_PAGES)('$file', (page) => {
  it.each(page.dates)('refused text in "%s" is reported and gated, and a good date lifts the gate', async (label) => {
    serve(page);
    const { default: Page } = await page.load();
    render(<Page />);
    if (page.prepare) await page.prepare();
    else await waitFor(() => expect(vi.mocked(apiFetch).mock.calls.length).toBeGreaterThan(0));
    await settle();
    for (const name of page.actions) await waitFor(() => expect(button(name).disabled).toBe(false));
    const field = screen.getByRole('textbox', { name: label }) as HTMLInputElement;
    const shown = field.value;
    const before = vi.mocked(apiFetch).mock.calls.length;

    typeDate(field, 'zz');
    expect(await screen.findByText(NOTICE)).toBeTruthy();
    await settle();
    expect(field.value).toBe('zz');
    for (const name of page.actions) expect(button(name).disabled, String(name)).toBe(true);
    expect(vi.mocked(apiFetch).mock.calls.length).toBe(before);

    typeDate(field, shown);
    await waitFor(() => expect(screen.queryByText(NOTICE)).toBeNull());
    for (const name of page.actions) await waitFor(() => expect(button(name).disabled).toBe(false));
  });
});
