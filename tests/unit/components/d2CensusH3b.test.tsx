/**
 * D2 census, group 3b: form reference data, dashboard widgets and one SSR load that read an unchecked
 * response. Per site: a 400 with the real error envelope shows the server's message; a 500 with an EMPTY
 * body shows a plain sentence (never "JSON" / "Unexpected end"); a 200 envelope renders its data.
 * The real apiFetch helpers (assertOk / apiErrorMessage) run on top of the mocked apiFetch.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, isReady: true, push: vi.fn() }) }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('next/head', () => ({ default: () => null }));
vi.mock('next/dynamic', () => ({ default: () => () => null }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/admin/AdminLayout', () => ({ AdminLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/shared/ExportCSVButton', () => ({ ExportCSVButton: () => null }));
vi.mock('@/components/accounting/time-tracking/TimeEntryModal', () => ({ TimeEntryModal: () => null }));
vi.mock('@/components/accounting/time-tracking/TimeEntriesTable', () => ({ TimeEntriesTable: () => null }));
vi.mock('@/components/accounting/time-tracking/TimeSummaryTab', () => ({ TimeSummaryTab: () => null }));
vi.mock('@/components/accounting/time-tracking/BulkActionsBar', () => ({ BulkActionsBar: () => null }));
vi.mock('@/components/accounting/time-tracking/TimeFilters', () => ({
  SummaryDateFilter: () => null,
  TimeFilters: ({ customers }: { customers: { id: string; companyName: string }[] }) => <ul>{customers.map(c => <li key={c.id}>{c.companyName}</li>)}</ul>,
}));
vi.mock('@/components/accounting/dashboard/OverviewTables', () => ({ OverviewTables: () => null }));
vi.mock('@/components/accounting/dashboard/TodoWidget', () => ({ TodoWidget: () => null }));
vi.mock('@/components/accounting/dashboard/WorkbenchSection', () => ({ WorkbenchSection: () => null }));
vi.mock('@/components/accounting/banking/NoBankAccountWarning', () => ({ NoBankAccountWarning: () => null }));
vi.mock('@/lib/auth/portalJwt', () => ({ verifyPortalToken: async () => ({ role: 'client_admin' }) }));

import { apiFetch } from '@/lib/apiFetch';
import LoanNewPage from '../../../pages/accounting/loans/new';
import RecurringInvoiceNewPage from '../../../pages/accounting/recurring-invoices/new';
import StockLevelsPage from '../../../pages/accounting/stock-levels/index';
import TimeTrackingPage from '../../../pages/accounting/time-tracking/index';
import AdminSettingsPage from '../../../pages/admin/settings';
import { OverviewTab } from '../../../src/components/accounting/dashboard/OverviewTab';
import { AssetDualTrackPanel } from '../../../src/components/assets/AssetDualTrackPanel';
import PortalDashboardPage, { getServerSideProps } from '../../../pages/accounting/afs/portal/dashboard';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
afterEach(() => { cleanup(); });

const MSG = 'D2 server says no: this data is not available';
const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const refuse = () => new Response(JSON.stringify({ success: false, error: { code: 'BAD_REQUEST', message: MSG } }), { status: 400 });
const emptyBody = () => new Response('', { status: 500 });
const NO_JSON = /JSON|Unexpected end/;
const ALERT = { health_alert_email: 'd2-alerts@example.test', health_alert_webhook_url: '' };
const SETTINGS = { maintenance_mode: false, registration_enabled: true, default_trial_days: 14, max_companies_per_user: 3, smtp_configured: true };
const KPI = { kpis: { revenue: { total: 0, priorTotal: 0, changePercent: 0 }, expenses: { total: 0, priorTotal: 0 }, grossProfit: { amount: 0, margin: 0 },
  netProfit: { amount: 0, margin: 0 }, cash: { total: 0, priorTotal: 0, change: 0 }, receivables: { total: 0, overdue: 0, avgDebtorDays: 0 },
  payables: { total: 0, overdue: 0, avgCreditorDays: 0 }, activity: { invoicesIssued: 0, paymentsReceived: 0, journalsPosted: 0 } },
  revenueChart: [], cashFlowChart: [], arAging: [], apAging: [], topCustomers: [], topExpenses: [], hasBankAccount: true };
const PERIOD = { yyyymm: '202601', periodDate: '2026-01-31', policyCost: 1000, policyOpeningAccDep: 0, policyCurrentDep: 10, policyClosingAccDep: 10,
  policyCarryingAmount: 990, taxCost: 1000, taxOpeningAccDep: 0, taxCurrentDep: 20, taxClosingAccDep: 20, taxCarryingAmount: 980, deferredTax: 1,
  disposalProceeds: null, policyProfitLoss: null, taxProfitLoss: null };

interface Site { name: string; ui: () => ReactElement; fails: string; rest?: (url: string) => Response; good: unknown; shows: () => Promise<unknown>; plain: RegExp }
const text = (re: RegExp) => async () => (await screen.findAllByText(re)).length;
const settingsRest = (url: string) => ok(url.includes('alert-settings') ? ALERT : SETTINGS);
const sites: Site[] = [
  { name: 'loans/new: rate curves', ui: () => <LoanNewPage />, fails: '/loan-rate-curves', good: [{ id: 'rc1', name: 'D2 Prime Curve' }], plain: /Could not load the rate curves - try again/,
    shows: async () => { fireEvent.change(await screen.findByDisplayValue('Fixed'), { target: { value: 'PRIME_PLUS' } }); return text(/D2 Prime Curve/)(); } },
  { name: 'recurring-invoices/new: customers', ui: () => <RecurringInvoiceNewPage />, fails: '/api/accounting/customers', good: [{ id: 'k1', company_name: 'D2 Debtor Ltd' }],
    shows: text(/D2 Debtor Ltd/), plain: /Could not load customers - try again/ },
  { name: 'stock-levels: the list', ui: () => <StockLevelsPage />, fails: '/stock-levels', good: { items: [{ id: 'i1', code: 'D2-STK', name: 'D2 Stock Item', current_stock: 5, reorder_level: 1,
    avg_cost: 2, selling_price: 3, unit: 'ea', category: 'c', stock_value: 10 }], summary: { totalProducts: 1, totalStockValue: 10, belowReorder: 0 } },
    shows: text(/D2 Stock Item/), plain: /Could not load stock levels - try again/ },
  { name: 'time-tracking: customers', ui: () => <TimeTrackingPage />, fails: '/api/accounting/customers', rest: () => ok({ entries: [], total: 0 }),
    good: [{ id: 'k1', companyName: 'D2 Billable Ltd' }], shows: text(/D2 Billable Ltd/), plain: /Could not load customers - try again/ },
  { name: 'admin settings: platform settings', ui: () => <AdminSettingsPage />, fails: '/api/admin/settings', rest: settingsRest, good: SETTINGS,
    shows: async () => screen.findByDisplayValue('d2-alerts@example.test'), plain: /Could not load the settings - try again/ },
  { name: 'admin settings: alert settings', ui: () => <AdminSettingsPage />, fails: '/api/admin/alert-settings', rest: settingsRest, good: ALERT,
    shows: async () => screen.findByDisplayValue('d2-alerts@example.test'), plain: /Could not load the alert settings - try again/ },
  { name: 'dashboard: provisional count', ui: () => <OverviewTab />, fails: 'provisional/outstanding', rest: u => ok(u.includes('kpi-dashboard') ? KPI : []),
    good: [{ id: 'p1' }, { id: 'p2' }], shows: text(/Provisional entries awaiting evidence: 2/), plain: /Could not load the provisional entry count - try again/ },
  { name: 'dashboard: missing invoice alerts', ui: () => <OverviewTab />, fails: 'expected-invoice-alerts', rest: u => ok(u.includes('kpi-dashboard') ? KPI : []),
    good: [{ id: 'm1' }], shows: text(/Missing invoices overdue: 1/), plain: /Could not load the missing invoice alerts - try again/ },
  { name: 'asset dual-track panel', ui: () => <AssetDualTrackPanel assetId="a1" />, fails: '/period-ledger', good: [PERIOD], shows: text(/Policy \(IAS 16\)/),
    plain: /Could not load the depreciation periods - try again/ },
];

function script(s: Site, answer: () => Response) {
  vi.mocked(apiFetch).mockReset().mockImplementation(async (url) => (String(url).includes(s.fails) ? answer() : (s.rest ?? (() => ok({})))(String(url))));
}

describe.each(sites)('$name', (s) => {
  it('400: the server message is shown', async () => {
    script(s, refuse);
    render(s.ui());
    expect(await screen.findByText(MSG, { exact: false })).toBeTruthy();
  });

  it('500 with an empty body: a plain sentence, not a JSON parse error', async () => {
    script(s, emptyBody);
    render(s.ui());
    expect(await screen.findByText(s.plain)).toBeTruthy();
    expect(screen.queryByText(NO_JSON)).toBeNull();
  });

  it('200: the data renders', async () => {
    script(s, () => ok(s.good));
    render(s.ui());
    expect(await s.shows()).toBeTruthy();
    expect(screen.queryByText(/Could not load|D2 server says no/)).toBeNull();
  });
});

describe('AFS portal dashboard (server-side load)', () => {
  const ctx = { req: { cookies: { portal_session: 'tok' } } } as unknown as Parameters<typeof getServerSideProps>[0];
  const page = async (answer: () => Response) => {
    vi.stubGlobal('fetch', async () => answer());
    const res = await getServerSideProps(ctx);
    if (!('props' in res)) throw new Error('expected props');
    render(<PortalDashboardPage {...(res.props as React.ComponentProps<typeof PortalDashboardPage>)} />);
  };

  it('400: the server message is shown, not "No financial statements"', async () => {
    await page(refuse);
    expect(await screen.findByText(MSG, { exact: false })).toBeTruthy();
  });

  it('500 with an empty body: a plain sentence, not a JSON parse error', async () => {
    await page(emptyBody);
    expect(await screen.findByText('Could not load your documents - try again')).toBeTruthy();
    expect(screen.queryByText(NO_JSON)).toBeNull();
  });

  it('200: the documents render with no error', async () => {
    await page(() => ok({ documents: [{ id: 'd1', fiscal_year: 2031, period: 'D2 Annual', document_type: 'afs', status: 'signed_off', created_at: '2031-01-01' }] }));
    expect(await screen.findByText('2031')).toBeTruthy();
    expect(screen.queryByText(/Could not load/)).toBeNull();
  });
});
