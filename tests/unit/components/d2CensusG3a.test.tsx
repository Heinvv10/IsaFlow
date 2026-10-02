// D2 census group 3a: a non-2xx on the main load shows the server's message (400) or a plain sentence (empty 500),
// never an empty table / raw "Unexpected end of JSON input". The REAL assertOk / apiErrorMessage run over a scripted apiFetch.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { MSG, bad, boom, expectNoRawJsonError, ok, script } from '../helpers/d2CensusG3';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: ReactNode }) => <a>{children}</a> }));
const route = vi.hoisted(() => ({ query: {} as Record<string, string>, asPath: '/', isReady: true, push: () => Promise.resolve(true), replace: () => Promise.resolve(true) }));
vi.mock('next/router', () => ({ useRouter: () => route }));
vi.mock('next/dynamic', () => ({ default: () => () => null }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
const company = vi.hoisted(() => ({ activeCompany: { id: 'c-1', name: 'Co' } }));  // stable identity: the pages key effects on it
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => company }));
vi.mock('@/hooks/useVatRegistration', () => ({ useVatRegistration: () => ({ isRegistered: true, known: true }) }));
vi.mock('@/components/accounting/AccountDrillDown', () => ({ AccountDrillDown: () => null }));
vi.mock('@/components/accounting/DataQualityNotice', () => ({ DataQualityNotice: () => null }));
vi.mock('@/components/accounting/RecordNavigation', () => ({ RecordNavigation: () => null }));
vi.mock('@/components/accounting/items/BundleEditor', () => ({ BundleEditor: () => null }));
vi.mock('@/components/accounting/dashboard/ChartOfAccountsTab', () => ({ ChartOfAccountsTab: () => null }));
vi.mock('@/components/accounting/fiscal-periods/CloseReadinessChecklist', () => ({ CloseReadinessChecklist: () => null }));
vi.mock('@/components/accounting/fiscal-periods/CreateYearModal', () => ({ CreateYearModal: () => null }));
vi.mock('@/components/shared/ExportCSVButton', () => ({ ExportCSVButton: () => null }));

import AdjustmentsPage from '../../../pages/accounting/adjustments/index';
import VatAdjustmentsPage from '../../../pages/accounting/vat-adjustments/index';
import PurchasesByItemReport from '../../../pages/accounting/reports/purchases-by-item';
import BudgetVsActualPage from '../../../pages/accounting/reports/budget-vs-actual';
import CustomerAllocationsPage from '../../../pages/accounting/customer-allocations/index';
import VatReconciliationPage from '../../../pages/accounting/reports/vat-reconciliation';
import ItemsListPage from '../../../pages/accounting/items/index';
import ItemDetailPage from '../../../pages/accounting/items/[itemId]';
import FinancialAnalysisPage from '../../../pages/accounting/reports/financial-analysis';
import ChartOfAccountsPage from '../../../pages/accounting/chart-of-accounts/index';
import { FiscalPeriodsTab } from '../../../src/components/accounting/dashboard/FiscalPeriodsTab';
import { LoanComplianceTab } from '../../../src/components/loans/LoanComplianceTab';

useApiJsonOverMock();
afterEach(() => { cleanup(); route.query = {}; });

interface Case {
  name: string; Page: () => JSX.Element; url: string; data: unknown; seen: string; sentence: RegExp;
  base?: (u: string) => Response; before?: () => Promise<void>; query?: Record<string, string>;
}
const cases: Case[] = [
  { name: 'adjustments list', Page: AdjustmentsPage, url: 'accounting/adjustments?',
    data: { items: [{ id: 'a1', adjustmentNumber: 'D2-ADJ-001', entityType: 'customer', entityId: 'e1', entityName: 'D2 Debtor', adjustmentType: 'debit', amount: 5, reason: 'r', adjustmentDate: '2026-09-01', status: 'draft' }] },
    seen: 'D2-ADJ-001', sentence: /Could not load adjustments/ },
  { name: 'adjustments customer dropdown', Page: AdjustmentsPage, url: 'accounting/customers',
    data: { clients: [{ id: 'c1', company_name: 'D2 Client Pty Ltd' }] }, seen: 'D2 Client Pty Ltd', sentence: /Could not load customers/,
    before: async () => { fireEvent.click(await screen.findByRole('button', { name: /New Adjustment/ })); } },
  { name: 'VAT adjustments', Page: VatAdjustmentsPage, url: 'accounting/vat-adjustments',
    data: { items: [{ id: 'v1', adjustmentNumber: 'D2-VATADJ-001', adjustmentDate: '2026-09-01', adjustmentType: 'input', amount: 5, reason: 'r', status: 'draft' }] },
    seen: 'D2-VATADJ-001', sentence: /Could not load VAT adjustments/ },
  { name: 'purchases by item', Page: PurchasesByItemReport, url: 'reports/purchases-by-item',
    data: [{ id: 'p1', itemCode: 'D2-PBI-CODE', name: 'D2 Purchased Item', category: 'x', poCount: 1, qtyOrdered: 2, totalCost: 10, avgCost: 5 }],
    seen: 'D2 Purchased Item', sentence: /Could not load the purchases report/ },
  { name: 'budget vs actual', Page: BudgetVsActualPage, url: 'reports-budget-vs-actual',
    data: { report: { period: 'current', total_budget: 1, total_actual: 1, total_variance: 0, lines: [{ account_code: '9999', account_name: 'D2 Budget Account', account_type: 'expense', budget_amount: 1, actual_amount: 1, variance: 0, variance_pct: 0 }] } },
    seen: 'D2 Budget Account', sentence: /Could not load the budget report/ },
  { name: 'customer allocations receipts', Page: CustomerAllocationsPage, url: 'customer-payments',
    data: [{ id: 'p1', paymentNumber: 'D2-RCPT-001', clientName: 'D2 Receipt Client', clientId: 'c1', date: '2026-09-01', totalAmount: 100, allocatedAmount: 0 }],
    seen: 'D2-RCPT-001', sentence: /Could not load receipts/ },
  { name: 'VAT reconciliation', Page: VatReconciliationPage, url: 'accounting/vat-reconciliation',
    data: { type: 'reconciliation', months: [], issues: [{ month: '2026-01', severity: 'warning', message: 'D2 reconciliation issue text' }],
      totals: { glRevenue: 0, glOutputVat: 0, glInputVat: 0, glNetVat: 0, invoiceRevenue: 0, returnNetVat: 0, capitalGoodsOutput: 0, capitalGoodsInput: 0, revenueVariance: 0, outputVatVariance: 0, inputVatVariance: 0 } },
    seen: 'D2 reconciliation issue text', sentence: /Could not load the VAT reconciliation/ },
  { name: 'items list', Page: ItemsListPage, url: 'accounting/items?',
    data: [{ id: 'i1', code: 'D2-ITEM-001', description: 'D2 Listed Widget', item_type: 'physical', category_id: null, category_name: null, selling_price_excl: 10, cost_price: 5, current_qty: 3, is_active: true, unit: 'ea' }],
    seen: 'D2 Listed Widget', sentence: /Could not load items/ },
  { name: 'item detail', Page: ItemDetailPage, url: 'accounting/items?id=', query: { itemId: 'i1' },
    data: { id: 'i1', code: 'D2-DETAIL-CODE', description: 'D2 Detail Widget', item_type: 'physical', selling_price_excl: 10, selling_price_incl: 11.5, cost_price: 5, current_qty: 3, unit: 'ea', is_active: true, is_bundle: false, created_at: '2026-09-01T00:00:00Z' },
    seen: 'D2-DETAIL-CODE', sentence: /Could not load the item/ },
  { name: 'financial analysis scorecard', Page: FinancialAnalysisPage, url: 'reports-kpi-scorecard', base: () => ok({}),
    data: { scorecard: [{ ratioKey: 'currentRatio', name: 'D2 Scorecard Ratio', value: 1, target: 1, status: 'green', percentOfTarget: 100 }], summary: { green: 1, amber: 0, red: 0, total: 1 } },
    seen: 'D2 Scorecard Ratio', sentence: /Could not load the financial analysis/ },
  { name: 'financial analysis trends', Page: FinancialAnalysisPage, url: 'reports-ratio-trends', base: () => ok({}),
    data: { trends: [{ ratioName: 'grossProfitMargin', values: [{ period: '2026-01', value: 1 }], trend: 'improving', changePercent: 12.3 }] }, seen: '\\+12\\.3%', sentence: /Could not load the financial analysis/ },
  { name: 'financial analysis extended ratios', Page: FinancialAnalysisPage, url: 'reports-extended-ratios', base: () => ok({}),
    data: { ratios: { currentRatio: 7.77 } }, seen: '7\\.77', sentence: /Could not load the financial analysis/ },
  { name: 'fiscal periods tab', Page: FiscalPeriodsTab, url: 'accounting/fiscal-periods',
    data: [{ id: 'f1', periodName: 'D2 Period 2026-09', fiscalYear: 2026, startDate: '2026-09-01', endDate: '2026-09-30', status: 'open' }],
    seen: 'D2 Period 2026-09', sentence: /Could not load fiscal periods/ },
  { name: 'loan compliance tab', Page: () => <LoanComplianceTab loanId="L1" />, url: 'loans/L1/compliance',
    data: [{ id: 'a1', assessmentDate: '2026-09-01', ncaFlagged: false, ncaPeriod: null, stage: 2, daysPastDue: 4321, eclAmount: 1, eclMethod: '12m', outstanding: 1, assessedAt: '2026-09-01' }],
    seen: '4321', sentence: /Could not load compliance history/ },
];

describe.each(cases)('$name', ({ Page, url, data, seen, sentence, base, before, query }) => {
  const mount = async () => { route.query = query ?? {}; render(<Page />); await before?.(); };
  it('400: shows the server message', async () => {
    script(url, bad, base);
    await mount();
    expect(await screen.findByText(MSG)).toBeTruthy();
  });
  it('500 with an empty body: shows a plain sentence, not the JSON parse error', async () => {
    script(url, boom, base);
    await mount();
    expect(await screen.findByText(sentence)).toBeTruthy();
    expectNoRawJsonError();
  });
  it('200: renders the data', async () => {
    script(url, () => ok(data), base);
    await mount();
    expect((await screen.findAllByText(new RegExp(seen))).length).toBeGreaterThan(0);
    expect(screen.queryByText(MSG)).toBeNull();
  });
});

describe('chart of accounts subtitle', () => {
  const subtitle = (re: RegExp) => screen.findByText(re);
  it('400: keeps the neutral subtitle - never claims the chart is empty', async () => {
    script('chart-of-accounts', bad);
    render(<ChartOfAccountsPage />);
    await subtitle(/Manage your general ledger accounts/);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText(/Pick a template/)).toBeNull();
    expectNoRawJsonError();
  });
  it('500 with an empty body: keeps the neutral subtitle, no parse error', async () => {
    script('chart-of-accounts', boom);
    render(<ChartOfAccountsPage />);
    await subtitle(/Manage your general ledger accounts/);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText(/Pick a template/)).toBeNull();
    expectNoRawJsonError();
  });
  it('200: shows the account count', async () => {
    script('chart-of-accounts', () => ok([{ id: 'a' }, { id: 'b' }, { id: 'c' }]));
    render(<ChartOfAccountsPage />);
    expect(await subtitle(/3 accounts in your general ledger/)).toBeTruthy();
  });
});
