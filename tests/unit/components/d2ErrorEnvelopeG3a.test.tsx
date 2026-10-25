/**
 * D2: the report pages read `json.message` (always undefined for the real envelope
 * `{ success:false, error:{ code, message } }`), so users saw a generic fallback. Each page now goes
 * through the real assertOk; this proves the server's own message is what the user sees.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/contexts/TableDensityContext', () => ({ useTableDensity: () => ({ rowClass: '' }) }));
vi.mock('@/contexts/CompanyContext', () => ({
  useCompany: () => ({ activeCompany: { id: 'co-1', vatPeriod: 'bi-monthly', vatSystemType: 'standard' }, loading: false }),
}));
vi.mock('next/router', () => ({
  useRouter: () => ({ query: {}, isReady: true, push: vi.fn(), replace: vi.fn(), pathname: '/' }),
}));

import { apiFetch } from '@/lib/apiFetch';

useApiJsonOverMock();
afterEach(cleanup);

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const ok = (data: unknown) => json({ success: true, data });
const refuse = (msg: string, status: number) => json({ success: false, error: { code: 'REFUSED', message: msg } }, status);

/** Answers `failUrl` with the real error envelope; everything else with a valid empty success envelope. */
function script(failUrl: string, msg: string, status: number, extra?: (u: string) => Response | null) {
  vi.mocked(apiFetch).mockReset().mockImplementation(async (url) => {
    const u = String(url);
    if (u.includes(failUrl)) return refuse(msg, status);
    return extra?.(u) ?? ok([]);
  });
}

beforeEach(() => { vi.mocked(apiFetch).mockReset(); });

const loadOnMount: Array<[string, () => Promise<{ default: () => React.ReactElement }>, string, number]> = [
  ['ap-aging', () => import('../../../pages/accounting/reports/ap-aging'), 'reports-ap-aging', 500],
  ['ar-aging', () => import('../../../pages/accounting/reports/ar-aging'), 'reports-ar-aging', 500],
  ['audit-trail', () => import('../../../pages/accounting/reports/audit-trail'), 'reports-audit-trail', 403],
  ['balance-sheet', () => import('../../../pages/accounting/reports/balance-sheet'), 'reports-balance-sheet', 422],
  ['customer-reports', () => import('../../../pages/accounting/reports/customer-reports'), 'reports-customer', 500],
  ['income-statement', () => import('../../../pages/accounting/reports/income-statement'), 'reports-income-statement', 422],
  ['management-accounts', () => import('../../../pages/accounting/reports/management-accounts'), 'reports-management-accounts', 500],
  ['project-profitability', () => import('../../../pages/accounting/reports/project-profitability'), 'reports-project-profitability', 400],
  ['supplier-reports', () => import('../../../pages/accounting/reports/supplier-reports'), 'reports-supplier', 500],
  ['disclosure-notes', () => import('../../../pages/accounting/reports/disclosure-notes'), '/api/accounting/disclosure-notes', 500],
  ['caseware-export', () => import('../../../pages/accounting/reports/caseware-export'), 'account-mappings', 500],
  ['my-reports', () => import('../../../pages/accounting/reports/my-reports'), 'custom-reports', 500],
];

// Each page pulls in a large module graph. On a loaded CI runner the first import
// of balance-sheet and management-accounts outlasted the 5 s test timeout, and the
// page then rendered against the NEXT test's mocks and crashed (CI, 2026-10-08).
// Load every page here, under its own budget, so each test imports from the cache.
beforeAll(async () => {
  await Promise.all([
    ...loadOnMount.map(([, load]) => load()),
    import('../../../pages/accounting/reports/bank-transactions'),
  ]);
}, 60_000);

describe('report pages show the server message when the load is refused', () => {
  for (const [name, loader, failUrl, status] of loadOnMount) {
    it(`${name} shows the server's message, not the generic fallback`, async () => {
      const msg = `D2 server says no: ${name} load refused`;
      script(failUrl, msg, status);
      const Page = (await loader()).default;
      render(<Page />);
      expect(await screen.findByText(new RegExp(msg))).toBeTruthy();
    });
  }
});

it('bank-transactions shows the server message when the report is refused', async () => {
  const msg = 'D2 server says no: bank-transactions report refused';
  script('reports-bank-transactions', msg, 500, (u) => u.includes('chart-of-accounts')
    ? ok([{ id: 'a1', accountCode: '1100', accountName: 'Cheque', parentAccountId: null }]) : null);
  const Page = (await import('../../../pages/accounting/reports/bank-transactions')).default;
  render(<Page />);
  expect(await screen.findByText(new RegExp(msg))).toBeTruthy();
});

/** Answers the first route whose key is in the URL with a valid success envelope; everything else with `[]`. */
function serve(routes: Record<string, unknown>) {
  vi.mocked(apiFetch).mockReset().mockImplementation(async (url) => {
    const hit = Object.keys(routes).find((k) => String(url).includes(k));
    return ok(hit ? routes[hit] : []);
  });
}
const lineItem = (accountName: string, amount: number) => ({ accountCode: '4000', accountName, amount, balance: amount });
const bucket = (b: string) => ({ bucket: b, count: 1, total: 100 });
const aged = { invoice_number: 'INV-1', invoice_date: '2026-09-01', due_date: '2026-09-30', total_amount: 100, amount_paid: 0, balance_due: 100, days_overdue: 5, bucket: '1-30' };
const party = { invoiceCount: 2, totalInvoiced: 100, totalPaid: 40, balance: 60 };

describe('report pages render the data they received (success path)', () => {
  const cases: Array<[string, () => Promise<{ default: () => React.ReactElement }>, Record<string, unknown>, string]> = [
    ['ap-aging', () => import('../../../pages/accounting/reports/ap-aging'),
      { 'reports-ap-aging': { rows: [{ ...aged, id: 'r1', supplier_name: 'Zanzibar Supplies' }], summary: [bucket('1-30')], as_at_date: '2026-10-02' } }, 'Zanzibar Supplies'],
    ['ar-aging', () => import('../../../pages/accounting/reports/ar-aging'),
      { 'reports-ar-aging': { rows: [{ ...aged, id: 'r1', customer_name: 'Quokka Traders' }], summary: [bucket('1-30')], as_at_date: '2026-10-02' } }, 'Quokka Traders'],
    ['audit-trail', () => import('../../../pages/accounting/reports/audit-trail'),
      { 'reports-audit-trail': [{ entryDate: '2026-10-01', entryNumber: 'JE-1', description: 'Walrus accrual', source: 'manual', status: 'posted', totalDebit: 5, totalCredit: 5, createdBy: 'u', createdAt: '2026-10-01', postedAt: null }] }, 'Walrus accrual'],
    ['customer-reports', () => import('../../../pages/accounting/reports/customer-reports'),
      { 'reports-customer': [{ clientId: 'c1', clientName: 'Pangolin Retail', ...party }] }, 'Pangolin Retail'],
    ['supplier-reports', () => import('../../../pages/accounting/reports/supplier-reports'),
      { 'reports-supplier': [{ supplierId: 's1', supplierName: 'Narwhal Wholesale', ...party }] }, 'Narwhal Wholesale'],
    ['project-profitability', () => import('../../../pages/accounting/reports/project-profitability'),
      { 'reports-project-profitability': [{ projectId: 'p1', projectName: 'Lynx Tower Build', periodStart: '', periodEnd: '', revenue: 10, costs: 4, profit: 6, margin: 60, revenueLines: [], costLines: [] }] }, 'Lynx Tower Build'],
    ['my-reports', () => import('../../../pages/accounting/reports/my-reports'),
      { 'custom-reports': { items: [{ id: 't1', name: 'Ocelot Quarterly Pack', description: null, dataSource: 'customers', isShared: false, createdBy: 'u', createdAt: '2026-09-01', updatedAt: '2026-09-01' }] } }, 'Ocelot Quarterly Pack'],
    ['disclosure-notes', () => import('../../../pages/accounting/reports/disclosure-notes'),
      { '/api/accounting/disclosure-notes': { notes: [{ noteNumber: 7, title: 'Axolotl Related Parties', content: 'c', source: 'auto' }] } }, 'Axolotl Related Parties'],
    ['caseware-export', () => import('../../../pages/accounting/reports/caseware-export'),
      { 'account-mappings': { items: [{ glAccountId: 'g1', accountCode: '1234', accountName: 'Tapir Petty Cash', accountType: 'asset', accountSubtype: null, externalCode: '', externalLabel: '' }] } }, 'Tapir Petty Cash'],
    ['income-statement', () => import('../../../pages/accounting/reports/income-statement'),
      { 'reports-income-statement': { periodStart: '2026-09-01', periodEnd: '2026-09-30', revenue: [lineItem('Gazelle Sales', 100)], otherIncome: [], costOfSales: [], operatingExpenses: [], otherExpenses: [], totalRevenue: 100, totalOtherIncome: 0, totalCostOfSales: 0, totalOperatingExpenses: 0, totalOtherExpenses: 0, grossProfit: 100, operatingProfit: 100, netProfit: 100 } }, 'Gazelle Sales'],
    ['balance-sheet', () => import('../../../pages/accounting/reports/balance-sheet'),
      { 'reports-balance-sheet': { asAtDate: '2026-09-30', assets: [lineItem('Ibex Bank Balance', 100)], liabilities: [], equity: [], totalAssets: 100, totalLiabilities: 0, totalEquity: 0 } }, 'Ibex Bank Balance'],
    ['management-accounts', () => import('../../../pages/accounting/reports/management-accounts'),
      { 'reports-management-accounts': { companyName: 'Co', periodStart: '2026-09-01', periodEnd: '2026-09-30', generatedAt: '2026-10-01T00:00:00Z',
        kpis: { revenue: 7654321, grossProfit: 1, grossProfitPct: 1, netProfit: 1, netProfitPct: 1, cashPosition: 1, totalAssets: 1, totalLiabilities: 1, totalEquity: 1 },
        incomeStatement: {}, balanceSheet: {}, cashFlow: { operatingCashFlow: 0, investingCashFlow: 0, financingCashFlow: 0, netCashFlow: 0, openingCash: 0, closingCash: 0 } } }, '7654321'],
  ];
  for (const [name, loader, routes, seen] of cases) {
    it(`success: ${name} renders the data it received`, async () => {
      serve(routes);
      const Page = (await loader()).default;
      const { container } = render(<Page />);
      await vi.waitFor(() => expect(container.textContent!.replace(/[\s ,.]/g, '')).toContain(seen.replace(/[\s,.]/g, '')));
    });
  }

  it('success: bank-transactions renders the data it received', async () => {
    serve({
      'chart-of-accounts': [{ id: 'a1', accountCode: '1100', accountName: 'Cheque', parentAccountId: null }],
      'reports-bank-transactions': { accountCode: '1100', accountName: 'Cheque', openingBalance: 0, closingBalance: 5,
        transactions: [{ date: '2026-10-01', entryNumber: 'JE-9', description: 'Marmot deposit', deposit: 5, withdrawal: 0, runningBalance: 5 }] },
    });
    const Page = (await import('../../../pages/accounting/reports/bank-transactions')).default;
    render(<Page />);
    expect(await screen.findByText('Marmot deposit')).toBeTruthy();
  });
});
