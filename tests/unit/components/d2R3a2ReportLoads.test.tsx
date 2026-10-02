/**
 * D2 round 3 (a2): a failed load/reload on a report page must not leave the PREVIOUS rows on screen under
 * the new filter next to the error. Per page: real 400 envelope, empty-body 500, a good 200, and
 * "load OK, change the filter, the reload 500s -> old rows gone, error shown".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

configure({ asyncUtilTimeout: 4000 });
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, push: vi.fn() }) }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('next/dynamic', () => ({ default: () => () => null }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/accounting/AccountDrillDown', () => ({ AccountDrillDown: () => null }));
vi.mock('@/hooks/useVatRegistration', () => ({ useVatRegistration: () => ({ known: true, isRegistered: true }) }));

import { apiFetch } from '@/lib/apiFetch';
import ItemMovement from '../../../pages/accounting/reports/item-movement';
import ItemQuantities from '../../../pages/accounting/reports/item-quantities';
import ItemValuation from '../../../pages/accounting/reports/item-valuation';
import PurchasesByItem from '../../../pages/accounting/reports/purchases-by-item';
import PurchasesBySupplier from '../../../pages/accounting/reports/purchases-by-supplier';
import SalesByCustomer from '../../../pages/accounting/reports/sales-by-customer';
import SalesByItem from '../../../pages/accounting/reports/sales-by-item';
import JournalEntries from '../../../pages/accounting/reports/journal-entries';
import SupplierPos from '../../../pages/accounting/reports/supplier-pos';
import CustomerCommunication from '../../../pages/accounting/reports/customer-communication';
import BudgetVsActual from '../../../pages/accounting/reports/budget-vs-actual';
import UnallocatedPayments from '../../../pages/accounting/reports/unallocated-payments';
import UnallocatedReceipts from '../../../pages/accounting/reports/unallocated-receipts';
import VatReconciliation from '../../../pages/accounting/reports/vat-reconciliation';
import ItemListing from '../../../pages/accounting/reports/item-listing';
import FinancialAnalysis from '../../../pages/accounting/reports/financial-analysis';

useApiJsonOverMock();
afterEach(() => { cleanup(); });

const MSG = 'D2 server says no: this report is not available';
type Mode = 'ok' | '400' | '500';
let mode: Mode = 'ok';
beforeEach(() => { mode = 'ok'; });

const envelope = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });

/** The request `match` answers per `mode`; every other request answers with its good data. */
function script(match: (u: string) => boolean, data: (u: string) => unknown) {
  vi.mocked(apiFetch).mockImplementation(async (url: unknown) => {
    const u = String(url);
    if (match(u) && mode === '400') return new Response(JSON.stringify({ success: false, error: { code: 'BAD_REQUEST', message: MSG } }), { status: 400 });
    if (match(u) && mode === '500') return new Response('', { status: 500 });
    return envelope(data(u));
  });
}

type Trigger = (c: HTMLElement) => void;
const dateInput: Trigger = c => fireEvent.change(c.querySelector('input[type="date"]') as HTMLInputElement, { target: { value: '2026-02-01' } });
const select: (v: string) => Trigger = v => c => fireEvent.change(c.querySelector('select') as HTMLSelectElement, { target: { value: v } });

interface Case {
  name: string; page: () => JSX.Element; match: (u: string) => boolean; data: (u: string) => unknown;
  shows: string; plain: RegExp; reload?: Trigger;
}

const PAY = [{ id: 'p1', paymentNumber: 'D2-PAY-1', supplierName: 'D2 Old Payee', clientName: 'D2 Old Payee', date: '2026-01-01', amount: 100, allocatedAmount: 0 }];
const SC = { scorecard: [{ ratioKey: 'k1', name: 'D2 Old KPI', value: 5, target: 5, status: 'green', percentOfTarget: 100 }], summary: { green: 1, amber: 0, red: 0, total: 1 } };
const BUD = { report: { period: 'current', lines: [{ account_code: '4000', account_name: 'D2 Old Budget Line', account_type: 'revenue', budget_amount: 10, actual_amount: 5, variance: 5, variance_pct: 50 }], total_budget: 10, total_actual: 5, total_variance: 5 } };
const RECON = { type: 'reconciliation', months: [], totals: { glRevenue: 0, glOutputVat: 0, glInputVat: 0, glNetVat: 0, invoiceRevenue: 0, returnNetVat: 0, capitalGoodsOutput: 0, capitalGoodsInput: 0, revenueVariance: 0, outputVatVariance: 0, inputVatVariance: 0 }, issues: [{ month: '2026-01', severity: 'error', message: 'D2 Old Recon Issue' }] };
const item = (n: string) => [{ id: 'i1', itemCode: 'D2-1', name: n, itemName: n, category: 'c', uom: 'ea', qtyOnHand: 1, minLevel: 0, lowStock: false, costPrice: 1, stockValue: 1, sellingPrice: 1, isActive: true, date: '2026-01-01', type: 'in', reference: 'r', qtyIn: 1, qtyOut: 0, balance: 1, poCount: 1, qtyOrdered: 1, totalCost: 1, avgCost: 1, timesSold: 1, qtySold: 1, totalRevenue: 1, avgPrice: 1 }];
const arr = (marker: string) => () => item(marker);

const CASES: Case[] = [
  { name: 'item movement', page: () => <ItemMovement />, match: u => u.includes('item-movement'), data: arr('D2 Old Item'), shows: 'D2 Old Item', plain: /Could not load the report - try again/, reload: dateInput },
  { name: 'item quantities (Low stock only toggle)', page: () => <ItemQuantities />, match: u => u.includes('item-quantities'), data: arr('D2 Old Item'), shows: 'D2 Old Item', plain: /Could not load the report - try again/, reload: c => fireEvent.click(c.querySelector('input[type="checkbox"]') as HTMLInputElement) },
  { name: 'item valuation', page: () => <ItemValuation />, match: u => u.includes('item-valuation'), data: arr('D2 Old Item'), shows: 'D2 Old Item', plain: /Could not load item valuation - try again/ },
  { name: 'purchases by item', page: () => <PurchasesByItem />, match: u => u.includes('purchases-by-item'), data: arr('D2 Old Item'), shows: 'D2 Old Item', plain: /Could not load the purchases report - try again/, reload: dateInput },
  { name: 'purchases by supplier', page: () => <PurchasesBySupplier />, match: u => u.includes('purchases-by-supplier'), data: () => [{ supplierId: 's1', supplierName: 'D2 Old Supplier', invoiceCount: 1, totalPurchases: 1, paymentsMade: 0, outstanding: 1 }], shows: 'D2 Old Supplier', plain: /Could not load the purchases report - try again/, reload: dateInput },
  { name: 'sales by customer', page: () => <SalesByCustomer />, match: u => u.includes('sales-by-customer'), data: () => [{ clientId: 'c1', clientName: 'D2 Old Customer', invoiceCount: 1, totalSales: 1, paymentsReceived: 0, outstanding: 1 }], shows: 'D2 Old Customer', plain: /Could not load sales by customer - try again/, reload: dateInput },
  { name: 'sales by item', page: () => <SalesByItem />, match: u => u.includes('sales-by-item'), data: arr('D2 Old Item'), shows: 'D2 Old Item', plain: /Could not load sales by item - try again/, reload: dateInput },
  { name: 'journal entries', page: () => <JournalEntries />, match: u => u.includes('reports-journal-entries'), data: () => ({ total: 1, entries: [{ id: 'j1', entryNumber: 'JE-D2-OLD', entryDate: '2026-01-01', description: 'x', source: 'manual', status: 'posted', totalDebits: 1, totalCredits: 1 }] }), shows: 'JE-D2-OLD', plain: /Could not load the journal report - try again/, reload: dateInput },
  { name: 'supplier POs', page: () => <SupplierPos />, match: u => u.includes('reports-supplier-pos'), data: () => ({ grandTotal: 1, grandPoCount: 1, suppliers: [{ supplierId: 's1', supplierName: 'D2 Old PO Supplier', poCount: 1, totalValue: 1, pos: [] }] }), shows: 'D2 Old PO Supplier', plain: /Could not load the report - try again/, reload: dateInput },
  { name: 'customer communication', page: () => <CustomerCommunication />, match: u => u.includes('customer-communication'), data: () => ({ total: 1, page: 1, limit: 50, records: [{ id: 'r1', customerId: null, customerName: 'D2 Old Recipient', email: 'a@b.c', documentType: 'invoice', subject: 's', sentAt: '2026-01-01T10:00:00Z', status: 'sent' }] }), shows: 'D2 Old Recipient', plain: /Could not load the report - try again/, reload: dateInput },
  { name: 'budget vs actual', page: () => <BudgetVsActual />, match: u => u.includes('reports-budget-vs-actual'), data: () => BUD, shows: 'D2 Old Budget Line', plain: /Could not load the budget report - try again/, reload: select('ytd') },
  { name: 'unallocated payments', page: () => <UnallocatedPayments />, match: u => u.includes('supplier-payments'), data: () => PAY, shows: 'D2-PAY-1', plain: /Could not load unallocated payments - try again/ },
  { name: 'unallocated receipts', page: () => <UnallocatedReceipts />, match: u => u.includes('customer-payments'), data: () => PAY, shows: 'D2-PAY-1', plain: /Could not load unallocated receipts - try again/ },
  { name: 'VAT reconciliation (reconData)', page: () => <VatReconciliation />, match: u => u.includes('vat-reconciliation'), data: () => RECON, shows: 'D2 Old Recon Issue', plain: /Could not load the VAT reconciliation - try again/, reload: dateInput },
  { name: 'item listing', page: () => <ItemListing />, match: u => u.includes('item-listing'), data: arr('D2 Old Item'), shows: 'D2 Old Item', plain: /Could not load the item listing - try again/, reload: c => fireEvent.change(screen.getByPlaceholderText('Search...'), { target: { value: 'zzz' } }) },
  { name: 'financial analysis (scorecard)', page: () => <FinancialAnalysis />, match: u => u.includes('kpi-scorecard'), shows: 'D2 Old KPI', plain: /Could not load the financial analysis - try again/,
    data: u => (u.includes('kpi-scorecard') ? SC : u.includes('ratio-trends') ? { trends: [] } : { ratios: {} }), reload: select('12') },
];

const waitShown = (text: string) => screen.findByText(text);
const JUNK = /JSON|Unexpected end|HTTP \d|^Failed$/;

describe.each(CASES)('$name', c => {
  const run = () => { script(c.match, c.data); return render(c.page()); };

  it('shows the server message for a real 400 envelope', async () => {
    mode = '400'; run();
    expect(await screen.findByText(MSG)).toBeTruthy();
    expect(screen.queryByText(c.shows)).toBeNull();
  });
  it('shows a plain sentence for an empty-body 500', async () => {
    mode = '500'; const { container } = run();
    expect(await screen.findByText(c.plain)).toBeTruthy();
    expect(container.textContent).not.toMatch(JUNK);
  });
  it('renders the data on a good 200', async () => {
    run();
    expect(await waitShown(c.shows)).toBeTruthy();
  });
  if (c.reload) {
    it('failed reload clears the old rows', async () => {
      const { container } = run();
      await waitShown(c.shows);
      mode = '500';
      c.reload!(container);
      expect(await screen.findByText(c.plain)).toBeTruthy();
      await waitFor(() => expect(screen.queryByText(c.shows)).toBeNull());
    });
  }
});

describe('financial analysis: a later request failing', () => {
  it('failed reload (ratios call) clears the scorecard that the earlier calls filled', async () => {
    const data = CASES[CASES.length - 1]!.data;
    script(u => u.includes('extended-ratios'), data);
    const { container } = render(<FinancialAnalysis />);
    await waitShown('D2 Old KPI');
    mode = '500';
    select('12')(container);
    expect(await screen.findByText(/Could not load the financial analysis - try again/)).toBeTruthy();
    await waitFor(() => expect(screen.queryByText('D2 Old KPI')).toBeNull());
  });
});

describe('VAT reconciliation: multi-year data', () => {
  const MULTI = { type: 'multi_year', summary: [{ year: 2031, totalOutputVat: 1, totalInputVat: 1, netVat: 0, totalRevenue: 1, effectiveRate: 15, returnsSubmitted: 1, returnsExpected: 1 }] };
  it('failed multi-year reload clears the old summary; failed monthly reload clears the old issues', async () => {
    const data = (u: string) => (u.includes('multi_year') ? MULTI : RECON);
    script(u => u.includes('vat-reconciliation'), data);
    const { container } = render(<VatReconciliation />);
    await waitShown('D2 Old Recon Issue');
    const view = container.querySelector('select') as HTMLSelectElement;
    fireEvent.change(view, { target: { value: 'multi_year' } });
    await screen.findByText('2031');
    fireEvent.change(view, { target: { value: 'reconciliation' } });
    await waitShown('D2 Old Recon Issue');
    mode = '500';
    fireEvent.change(view, { target: { value: 'multi_year' } });
    expect(await screen.findByText(/Could not load the VAT reconciliation - try again/)).toBeTruthy();
    expect(screen.queryByText('2031')).toBeNull();
    fireEvent.change(view, { target: { value: 'reconciliation' } });
    await waitFor(() => expect(screen.queryByText('D2 Old Recon Issue')).toBeNull());
  });
});

describe('budget vs actual: stale export', () => {
  it('after a failed period reload the Export CSV button is disabled (it would export the old period)', async () => {
    script(u => u.includes('reports-budget-vs-actual'), () => BUD);
    const { container } = render(<BudgetVsActual />);
    await waitShown('D2 Old Budget Line');
    const btn = () => screen.getByText('Export CSV').closest('button') as HTMLButtonElement;
    expect(btn().disabled).toBe(false);
    mode = '500';
    select('ytd')(container);
    expect(await screen.findByText(/Could not load the budget report - try again/)).toBeTruthy();
    await waitFor(() => expect(btn().disabled).toBe(true));
  });
});
