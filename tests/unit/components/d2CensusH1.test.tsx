/**
 * D2 census group 1 (a): reference/main loads that called res.json() with no ok check. For each: a 400 envelope
 * shows the server message, an empty-body 500 shows a plain sentence (never the JSON parse error), a 200 renders.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, render, screen } from '@testing-library/react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, push: vi.fn() }) }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/admin/AdminLayout', () => ({ AdminLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ activeCompany: { id: 'co-1' } }) }));
vi.mock('@/components/accounting/ScanAndFillButton', () => ({ ScanAndFillButton: () => null }));

import { apiFetch } from '@/lib/apiFetch';
import AssetCategoriesPage from '../../../pages/accounting/assets/categories';
import ItemsListPage from '../../../pages/accounting/items/index';
import ConsolidatedBalanceSheetPage from '../../../pages/accounting/group/balance-sheet';
import BankTransactionsReportPage from '../../../pages/accounting/reports/bank-transactions';
import IntegrationsMcpPage from '../../../pages/accounting/settings/integrations-mcp';
import AdminAuditPage from '../../../pages/admin/audit';
import NewCustomerInvoicePage from '../../../pages/accounting/customer-invoices/new';
import { ConvertTrialModal } from '../../../src/components/admin/ConvertTrialModal';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
afterEach(() => { cleanup(); });

const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const envelope = (m: string) => new Response(JSON.stringify({ success: false, error: { code: 'BAD_REQUEST', message: m } }), { status: 400 });
const empty500 = () => new Response('', { status: 500 });
const MSG = 'D2 server says no: this data is not available';

interface Case {
  name: string;
  page: () => JSX.Element;
  fails: (url: string) => boolean;
  good: unknown;
  /** Answer for every other request, by URL. */
  rest?: (url: string) => unknown;
  shows: RegExp;
  plain: RegExp;
}

const BS = { rows: [], entityNames: {}, totalAssets: { entities: {}, elimination: 0, consolidated: 0 },
  totalLiabilities: { entities: {}, elimination: 0, consolidated: 0 }, totalEquity: { entities: {}, elimination: 0, consolidated: 0 },
  totalLiabilitiesAndEquity: { entities: {}, elimination: 0, consolidated: 0 } };
const CATEGORY = { id: 'c1', name: 'D2 Vehicles', code: 'D2V', sars_rate: 20, sars_years: 5, description: '', useful_life_years: 5,
  residual_pct: 0, tax_life_years: 5, ias16_group: 'CE', capitalization_threshold: null, tax_code: null, depreciation_method: 'straight_line' };
const ITEM = { id: 'i1', code: 'D2-ITEM', description: 'D2 Widget', item_type: 'physical', category_id: null, category_name: null,
  selling_price_excl: 1, cost_price: 1, current_qty: 1, is_active: true, unit: 'ea' };
const AUDIT_EMPTY = { items: [], total: 0, page: 1, limit: 50, total_pages: 1 };

const CASES: Case[] = [
  { name: 'asset categories', page: () => <AssetCategoriesPage />, fails: u => u.includes('assets-categories'), good: [CATEGORY],
    shows: /D2 Vehicles/, plain: /Could not load asset categories - try again/ },
  { name: 'items: list', page: () => <ItemsListPage />, fails: u => u.includes('/items?'), good: [ITEM],
    shows: /D2 Widget/, plain: /Could not load items - try again/ },
  { name: 'items: category filter', page: () => <ItemsListPage />, fails: u => u.includes('item-categories'),
    good: [{ id: 'k1', name: 'D2 Category Filter' }], shows: /D2 Category Filter/, plain: /Could not load item categories - try again/ },
  { name: 'group balance sheet: group list', page: () => <ConsolidatedBalanceSheetPage />, fails: u => u.includes('company-groups'),
    good: [{ id: 'g1', name: 'D2 Holdings Group' }], rest: u => (u.includes('consolidated-reports') ? BS : []),
    shows: /D2 Holdings Group/, plain: /Could not load company groups - try again/ },
  { name: 'bank transactions report: bank accounts', page: () => <BankTransactionsReportPage />, fails: u => u.includes('chart-of-accounts'),
    good: [{ id: 'a1', accountCode: '1D2B', accountName: 'D2 Current', parentAccountId: null }],
    rest: () => ({ accountCode: '1D2B', accountName: 'D2 Current', openingBalance: 0, closingBalance: 0, transactions: [] }),
    shows: /1D2B/, plain: /Could not load bank accounts - try again/ },
  { name: 'MCP integration: availability check', page: () => <IntegrationsMcpPage />, fails: u => u.includes('features/check'),
    good: { enabled: true }, shows: /Endpoint/, plain: /Could not check whether the MCP Connector is available - try again/ },
  { name: 'admin audit: company filter', page: () => <AdminAuditPage />, fails: u => u.includes('/admin/companies'),
    good: { items: [{ id: 'co9', name: 'D2 Company Alpha' }] }, rest: u => (u.includes('/admin/audit') ? AUDIT_EMPTY : []),
    shows: /D2 Company Alpha/, plain: /Could not load the company list - try again/ },
  { name: 'convert trial: plans', page: () => <ConvertTrialModal companyId="c1" companyName="D2 Co" onClose={vi.fn()} onConverted={vi.fn()} />,
    fails: u => u.includes('billing/plans'), good: [{ id: 'p1', name: 'D2 Pro Plan', code: 'pro', monthly_price_cents: 100, currency: 'ZAR' }],
    shows: /D2 Pro Plan/, plain: /Could not load plans - try again/ },
  { name: 'new customer invoice: clients', page: () => <NewCustomerInvoicePage />, fails: u => u.endsWith('/accounting/customers'),
    good: [{ id: 'cl1', name: 'D2 Client Co' }], shows: /D2 Client Co/, plain: /Could not load clients - try again/ },
  { name: 'new customer invoice: currencies', page: () => <NewCustomerInvoicePage />, fails: u => u.includes('/currencies'),
    good: [{ code: 'USD', name: 'D2 Dollar', symbol: '$' }], shows: /D2 Dollar/, plain: /Could not load currencies - try again/ },
];

function script(c: Case, answer: () => Response) {
  vi.mocked(apiFetch).mockReset().mockImplementation(async (url) => {
    const u = String(url);
    return c.fails(u) ? answer() : ok(c.rest ? c.rest(u) : []);
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
    expect((await screen.findAllByText(c.shows)).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Could not load|Could not check|D2 server says no/)).toBeNull();
  });
});
