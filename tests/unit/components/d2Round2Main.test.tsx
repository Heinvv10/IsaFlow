/**
 * D2 round 2: the main data load of these pages used to call res.json() without an ok check, so a 400
 * left an empty table and an empty-body 500 printed "Unexpected end of JSON input". Each case answers
 * the load with (1) the real error envelope, (2) an empty-body 500, (3) a good 200 that must render.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, push: vi.fn() }) }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ activeCompany: { id: 'co-1' } }) }));
vi.mock('@/components/shared/ExportCSVButton', () => ({ ExportCSVButton: () => null }));

import { apiFetch } from '@/lib/apiFetch';
import BudgetsPage from '../../../pages/accounting/budgets/index';
import RecurringJournalsPage from '../../../pages/accounting/recurring-journals/index';
import WriteOffsPage from '../../../pages/accounting/write-offs/index';
import BusinessUnitsPage from '../../../pages/accounting/business-units/index';
import OpeningBalancesPage from '../../../pages/accounting/opening-balances/index';
import DrcVatPage from '../../../pages/accounting/drc-vat/index';
import FinancialYearsPage from '../../../pages/accounting/financial-years/index';

useApiJsonOverMock();
afterEach(() => { cleanup(); });

const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const envelope = (m: string) => new Response(JSON.stringify({ success: false, error: { code: 'BAD_REQUEST', message: m } }), { status: 400 });
const empty500 = () => new Response('', { status: 500 });
const MSG = 'D2 server says no: this data is not available';

interface Case {
  name: string;
  page: () => JSX.Element;
  /** The request that fails; every other request answers with `rest`. */
  fails: (url: string) => boolean;
  good: unknown;
  rest?: unknown;
  /** What a good 200 renders; omitted for a secondary list that only fills a form (then: no error shown). */
  shows?: RegExp;
  plain: RegExp;
}

const PERIOD = { id: 'p1', periodName: 'D2 January 2026', periodNumber: 1, fiscalYear: 2026, startDate: '2026-01-01',
  endDate: '2026-01-31', status: 'open', createdAt: '2026-01-01', updatedAt: '2026-01-01' };
const BUDGET = { id: 'b1', glAccountId: 'g1', accountCode: '4000', accountName: 'D2 Sales Budget', accountType: 'revenue',
  fiscalYear: 2026, annualAmount: 1200, months: Array(12).fill(100) };

const CASES: Case[] = [
  { name: 'budgets', page: () => <BudgetsPage />, fails: u => u.includes('/budgets?fiscal_year'), good: { items: [BUDGET] },
    shows: /D2 Sales Budget/, plain: /Could not load budgets - try again/ },
  { name: 'budgets: GL account list', page: () => <BudgetsPage />, fails: u => u.includes('chart-of-accounts'), good: [],
    plain: /Could not load GL accounts - try again/ },
  { name: 'recurring journals', page: () => <RecurringJournalsPage />, fails: u => u.endsWith('/recurring-journals'),
    good: { items: [{ id: 'r1', templateName: 'D2 Rent template', frequency: 'monthly', nextRunDate: '2027-01-01', runCount: 0,
      status: 'active', totalAmount: 10, lines: [] }] }, shows: /D2 Rent template/, plain: /Could not load recurring journals - try again/ },
  { name: 'recurring journals: account list', page: () => <RecurringJournalsPage />, fails: u => u.includes('chart-of-accounts'),
    good: [], plain: /Could not load accounts - try again/ },
  { name: 'write-offs', page: () => <WriteOffsPage />, fails: u => u.endsWith('/write-offs'),
    good: { items: [{ id: 'w1', writeOffNumber: 'WO-D2-1', clientId: 'c1', invoiceId: 'i1', amount: 5, reason: 'x',
      writeOffDate: '2026-01-01', status: 'draft' }] }, shows: /WO-D2-1/, plain: /Could not load write-offs - try again/ },
  { name: 'write-offs: client list', page: () => <WriteOffsPage />, fails: u => u.endsWith('/accounting/customers'),
    good: [], plain: /Could not load clients - try again/ },
  { name: 'business units', page: () => <BusinessUnitsPage />, fails: u => u.includes('/business-units'),
    good: [{ id: 'u1', name: 'D2 Coastal Unit', code: 'CU', isActive: true }], shows: /D2 Coastal Unit/, plain: /Could not load business units - try again/ },
  { name: 'opening balances', page: () => <OpeningBalancesPage />, fails: u => u.includes('/opening-balances'),
    good: { accounts: [{ id: 'a1', account_code: '1D2X', account_name: 'D2 Bank', account_type: 'asset', normal_balance: 'debit',
      opening_debit: 0, opening_credit: 0 }] }, shows: /1D2X/, plain: /Could not load accounts - try again/ },
  { name: 'DRC VAT (eligible)', page: () => <DrcVatPage />, fails: u => u.endsWith('/drc-vat'),
    good: { items: [{ id: 'd1', invoiceNumber: 'INV-D2-1', supplierName: 'D2 Supplier', totalAmount: 100, vatAmount: 15,
      invoiceDate: '2026-01-01' }] }, shows: /INV-D2-1/, plain: /Could not load DRC VAT data - try again/ },
  { name: 'DRC VAT (history)', page: () => <DrcVatPage />, fails: u => u.includes('tab=history'), good: { items: [] }, plain: /Could not load DRC VAT data - try again/ },
  { name: 'financial years', page: () => <FinancialYearsPage />, fails: u => u.endsWith('/fiscal-years'),
    good: [{ id: 'y1', fiscalYear: 2026, startDate: '2026-01-01', endDate: '2026-12-31', status: 'open', kind: 'normal', stored: true, months: 12, periods: [PERIOD] }],
    shows: /D2 January 2026/, plain: /Could not load fiscal periods - try again/ },
];

function script(c: Case, answer: () => Response) {
  vi.mocked(apiFetch).mockReset().mockImplementation(async (url) => {
    const u = String(url);
    if (c.fails(u)) return answer();
    return ok(c.rest ?? (u.includes('jeCounts') ? {} : []));
  });
}

describe.each(CASES)('$name', (c) => {
  it('400: the server message is shown', async () => {
    script(c, () => envelope(MSG));
    render(c.page());
    expect(await screen.findByText(new RegExp(MSG))).toBeTruthy();
  });

  it('500 with an empty body: a plain sentence, not a JSON parse error', async () => {
    script(c, empty500);
    render(c.page());
    expect(await screen.findByText(c.plain)).toBeTruthy();
    expect(screen.queryByText(/JSON|Unexpected end/)).toBeNull();
  });

  it('200: the data renders', async () => {
    script(c, () => ok(c.good));
    render(c.page());
    if (c.shows) expect((await screen.findAllByText(c.shows)).length).toBeGreaterThan(0);
    else await vi.waitFor(() => expect(vi.mocked(apiFetch)).toHaveBeenCalled());
    expect(screen.queryByText(/Could not load|D2 server says no/)).toBeNull();
  });
});
