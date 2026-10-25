// D2 round 9: SUCCESS paths of converted pages, served with the REAL route envelope and asserting the rendered fields.
//   reports/three-way-forecast, suppliers/dedup, practice/staff-cost-rates, payroll/emp501, fraud/signals.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { empty500, expectNoJargon, ok, on, serve } from '../helpers/d2R3a6';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, push: vi.fn(), pathname: '/' }) }));
vi.mock('next/link', () => ({ default: ({ children }: { children: ReactNode }) => <a>{children}</a> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));

import { apiFetch } from '@/lib/apiFetch';
import ForecastPage from '../../../pages/accounting/reports/three-way-forecast';
import DedupPage from '../../../pages/accounting/suppliers/dedup';
import StaffCostRatesPage from '../../../pages/accounting/practice/staff-cost-rates/index';
import Emp501Page from '../../../pages/payroll/emp501/index';
import FraudSignalsPage from '../../../pages/accounting/fraud/signals';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
beforeEach(() => { vi.mocked(apiFetch).mockReset(); });
afterEach(() => { cleanup(); });

describe('three-way forecast (route: { forecast: { months, params, generatedAt }, historical, params, unclassifiedAccounts })', () => {
  const month = {
    month: 1, label: 'D2-Jan-27',
    pnl: { revenue: 777, costOfSales: 111, grossProfit: 666, operatingExpenses: 222, ebit: 444, taxExpense: 121, netProfit: 323 },
    balanceSheet: { cash: 888, totalAssets: 555, totalLiabilities: 99, totalEquity: 456, currentAssets: 345, currentLiabilities: 88 },
    cashFlow: { operatingCashFlow: 600, investingCashFlow: 70, financingCashFlow: 60, netCashFlow: 730, closingCash: 444 },
  };
  const forecast = { months: [month], params: { revenueGrowthRate: 5, costOfSalesGrowthRate: 3, opexGrowthRate: 2, capitalExpenditure: 0 }, generatedAt: '2026-10-01' };
  it('Run Forecast renders the P&L, then the balance sheet and cash flow tabs, from the response fields', async () => {
    serve(on('GET', 'reports-three-way-forecast', () => ok({ forecast, historical: {}, params: {}, unclassifiedAccounts: null })));
    render(<ForecastPage />);
    fireEvent.click(screen.getByRole('button', { name: /Run Forecast/ }));
    expect(await screen.findByText('D2-Jan-27')).toBeDefined();
    expect(screen.getByText('R 777')).toBeDefined();   // pnl.revenue
    expect(screen.getByText('R 323')).toBeDefined();   // pnl.netProfit
    fireEvent.click(screen.getByRole('button', { name: 'Balance Sheet' }));
    expect(screen.getByText('R 555')).toBeDefined();   // balanceSheet.totalAssets
    expect(screen.getByText('R 456')).toBeDefined();   // balanceSheet.totalEquity
    fireEvent.click(screen.getByRole('button', { name: 'Cash Flow' }));
    expect(screen.getByText('R 730')).toBeDefined();   // cashFlow.netCashFlow
    expect(screen.getByText('R 444')).toBeDefined();   // cashFlow.closingCash
  });
  it('an empty 500 shows a sentence and no forecast table', async () => {
    serve(on('GET', 'reports-three-way-forecast', empty500));
    render(<ForecastPage />);
    fireEvent.click(screen.getByRole('button', { name: /Run Forecast/ }));
    expect(await screen.findByText('Could not run the forecast - try again')).toBeDefined();
    expect(screen.queryByText('Line Item')).toBeNull(); expectNoJargon();
  });
});

describe('suppliers/dedup (route: data = SupplierDuplicatePair[])', () => {
  const pair = { id_a: 'a1', name_a: 'D2 Acme Traders', email_a: 'acme-d2@x.test', vat_a: '4111111111', invoice_count_a: 7,
    id_b: 'b1', name_b: 'D2 Acme Trading', email_b: null, vat_b: null, invoice_count_b: 3, match_reason: 'email' };
  it('Scan lists both suppliers of each pair with their email', async () => {
    serve(on('GET', 'supplier-duplicates', () => ok([pair])));
    render(<DedupPage />);
    fireEvent.click(screen.getAllByRole('button', { name: /scan/i })[0]!);
    expect(await screen.findByText('D2 Acme Traders')).toBeDefined();
    expect(screen.getByText('D2 Acme Trading')).toBeDefined();
    expect(document.body.textContent).toContain('acme-d2@x.test');
  });
  it('a clean scan says the list looks clean; an empty 500 says so in a sentence and lists nothing', async () => {
    serve(on('GET', 'supplier-duplicates', () => ok([])));
    render(<DedupPage />);
    fireEvent.click(screen.getAllByRole('button', { name: /scan/i })[0]!);
    expect(await screen.findByText(/supplier list looks clean/)).toBeDefined();
    cleanup();
    serve(on('GET', 'supplier-duplicates', empty500));
    render(<DedupPage />);
    fireEvent.click(screen.getAllByRole('button', { name: /scan/i })[0]!);
    expect(await screen.findByText('Could not scan for duplicates - try again')).toBeDefined();
    expect(screen.queryByText(/looks clean/)).toBeNull();
  });
});

describe('practice/staff-cost-rates (routes: practice/users -> CompanyUserSummary[], staff-cost-rates -> StaffCostRate[])', () => {
  const user = { id: 'u1', email: 'd2@x.test', firstName: 'D2', lastName: 'Staffer', displayName: 'D2 Staffer', companyRole: 'accountant' };
  const rate = { id: 'r1', companyId: 'c1', userId: 'u1', costRate: 123.45, currency: 'ZAR', effectiveFrom: '2026-01-01', effectiveTo: '2026-12-31',
    notes: 'D2 rate note', createdBy: null, createdAt: '2026-01-01T00:00:00Z' };
  it('shows the staff name (resolved from the user list), rate, dates and note of each rate', async () => {
    serve(on('GET', 'practice/users', () => ok([user])), on('GET', 'practice/staff-cost-rates', () => ok([rate])));
    render(<StaffCostRatesPage />);
    expect(await screen.findByText('R 123.45')).toBeDefined();
    const row = screen.getByText('R 123.45').closest('tr') as HTMLElement;
    expect(within(row).getByText('D2 Staffer')).toBeDefined();
    expect(within(row).getByText('2026-01-01')).toBeDefined();
    expect(within(row).getByText('2026-12-31')).toBeDefined();
    expect(within(row).getByText('D2 rate note')).toBeDefined();
  });
  it('an empty 500 shows a sentence and no rate rows', async () => {
    serve(on('GET', 'practice/users', empty500), on('GET', 'practice/staff-cost-rates', empty500));
    render(<StaffCostRatesPage />);
    expect(await screen.findByText(/Could not load the (staff list|cost rates) - try again/)).toBeDefined();
    expect(screen.queryByText('R 123.45')).toBeNull(); expectNoJargon();
  });
});

describe('payroll/emp501 (route: data = { taxYear, rows, totalEmp201, totalIrp5, totalVariance })', () => {
  const summary = { taxYear: 2027, totalEmp201: 3000, totalIrp5: 2990, totalVariance: 10,
    rows: [
      { month: 3, monthLabel: 'D2 March', year: 2026, emp201Paye: 1500, irp5Paye: 1400, variance: 100, status: 'variance' },
      { month: 4, monthLabel: 'D2 April', year: 2026, emp201Paye: 0, irp5Paye: 0, variance: 0, status: 'no_data' },
    ] };
  it('renders each month, its PAYE figures, status, and the totals', async () => {
    serve(on('GET', 'emp501/reconciliation', () => ok(summary)));
    render(<Emp501Page />);
    const march = (await screen.findByText('D2 March')).closest('tr') as HTMLElement;
    expect(march.textContent).toMatch(/1[\s\u00a0\u202f]500/); // emp201Paye (en-ZA grouping may use a NBSP)
    expect(march.textContent).toMatch(/1[\s\u00a0\u202f]400/); // irp5Paye
    expect(within(march).getByText('Variance')).toBeDefined();
    const april = screen.getByText('D2 April').closest('tr') as HTMLElement;
    expect(within(april).getByText('No Data')).toBeDefined();
    expect(document.body.textContent).toMatch(/3[\s ]000/); // totalEmp201
  });
  it('an empty 500 shows a sentence and no month rows', async () => {
    serve(on('GET', 'emp501/reconciliation', empty500));
    render(<Emp501Page />);
    expect(await screen.findByText('Could not load the EMP501 reconciliation - try again')).toBeDefined();
    expect(screen.queryByText('D2 March')).toBeNull(); expectNoJargon();
  });
});

describe('fraud/signals (route: data = { alerts, total })', () => {
  const alert = { id: 'f1', supplierId: 's1', supplierName: 'D2 Shady Supplies', signalType: 'bank_change', severity: 'critical',
    evidence: { oldAccount: '1110002', newAccount: '9990009' }, status: 'pending', firstSeenAt: '2026-09-01T08:00:00Z' };
  it('lists each alert: supplier, signal label, severity, evidence, and Confirm/Dismiss while pending', async () => {
    serve(on('GET', 'fraud/signals', () => ok({ alerts: [alert], total: 1 })));
    render(<FraudSignalsPage />);
    const item = (await screen.findByText('D2 Shady Supplies')).closest('li') as HTMLElement;
    expect(within(item).getByText('Bank account change')).toBeDefined();
    expect(within(item).getByText('critical')).toBeDefined();
    expect(item.textContent).toContain('9990009');
    expect(within(item).getAllByRole('button').length).toBeGreaterThanOrEqual(2);
  });
  it('an empty 500 shows a sentence and no alert rows', async () => {
    serve(on('GET', 'fraud/signals', empty500));
    render(<FraudSignalsPage />);
    expect(await screen.findByText(/Could not load/)).toBeDefined();
    expect(screen.queryByText('D2 Shady Supplies')).toBeNull(); expectNoJargon();
  });
});
