// D2 round 9 (pages 1/3): each page below had no component test importing it. SUCCESS renders a distinctive field read
// from the REAL route envelope; an empty 500 shows one sentence and no rows.
//   wip-aging, sars/emp201, sars/index, settings/billing/compare, settings/billing/flows/return, settings/currencies, supplier-invoices/index.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { empty500, expectNoJargon, ok, on, serve } from '../helpers/d2R3a6';

const route = vi.hoisted(() => ({ query: {} as Record<string, string>, isReady: true, pathname: '/', push: vi.fn(), replace: vi.fn() }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/router', () => ({ useRouter: () => route }));
vi.mock('next/link', () => ({ default: ({ children }: { children: ReactNode }) => <a>{children}</a> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: 'owner', companyId: 'c1', activeCompany: { id: 'c1' }, loading: false }) }));
vi.mock('@/hooks/useVatRegistration', () => ({ useVatRegistration: () => ({ isRegistered: true, known: true }) }));

import { apiFetch } from '@/lib/apiFetch';
import WipAgingPage from '../../../pages/accounting/practice/reports/wip-aging';
import Emp201Page from '../../../pages/accounting/sars/emp201';
import SarsIndexPage from '../../../pages/accounting/sars/index';
import ComparePage from '../../../pages/accounting/settings/billing/compare';
import FlowsReturnPage from '../../../pages/accounting/settings/billing/flows/return';
import CurrenciesPage from '../../../pages/accounting/settings/currencies';
import SupplierInvoicesPage from '../../../pages/accounting/supplier-invoices/index';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
beforeEach(() => { vi.mocked(apiFetch).mockReset(); route.query = {}; route.isReady = true; });
afterEach(() => { cleanup(); });
const NBSP = /[\s  ]/;

describe('practice/reports/wip-aging (route: data = WipAgingRow[])', () => {
  const row = { practiceClientId: 'pc1', legalName: 'D2 Client Pty', bucket0to7: 111, bucket8to14: 222, bucket15to30: 333, bucket31plus: 444, total: 1110 };
  it('success: the client row carries each bucket and the total', async () => {
    serve(on('GET', 'wip-aging', () => ok([row])));
    render(<WipAgingPage />);
    const tr = (await screen.findByText('D2 Client Pty')).closest('tr') as HTMLElement;
    for (const v of ['111.00', '222.00', '333.00', '444.00', '1,110.00']) expect(tr.textContent).toContain(v);
  });
  it('empty 500: a sentence, no rows; a failing reload drops the rows already shown', async () => {
    let fail = false;
    serve((u, m) => (m === 'GET' && u.includes('wip-aging') ? (fail ? empty500() : ok([row])) : undefined));
    const { container } = render(<WipAgingPage />);
    await screen.findByText('D2 Client Pty');
    fail = true;
    fireEvent.change(container.querySelector('input[type="date"]') as HTMLInputElement, { target: { value: '2026-01-31' } });
    expect(await screen.findByText('Could not load the WIP aging report - try again')).toBeDefined();
    expect(screen.queryByText('D2 Client Pty')).toBeNull(); expectNoJargon();
  });
});

describe('sars/emp201 (route: data = EMP201Data)', () => {
  const emp = { periodStart: '2026-09-01', periodEnd: '2026-09-30', totalPAYE: 555, totalETI: 55, payePayable: 500, totalUIF_employee: 12, totalUIF_employer: 13,
    totalUIF: 25, totalSDL: 77, employeeCount: 17, totalTaxableRemuneration: 888, totalDeductions: 602,
    payrollRuns: [{ id: 'r1', runDate: '2026-09-25', employeeCount: 17, grossPay: 999, paye: 555, uif: 25, sdl: 77 }] };
  const rowOf = (label: string) => (screen.getByText(label).parentElement as HTMLElement).textContent ?? '';
  it('Generate renders each EMP201 line from the response', async () => {
    serve(on('GET', 'sars-emp201', () => ok(emp)));
    render(<Emp201Page />);
    fireEvent.click(screen.getByRole('button', { name: /Generate/ }));
    await screen.findByText('Number of employees');
    expect(rowOf('Number of employees')).toContain('17');
    expect(rowOf('Total taxable remuneration')).toMatch(/888,00/);
    expect(rowOf('PAYE payable')).toMatch(/500,00/);
    expect(rowOf('Total UIF')).toMatch(/25,00/);
    expect(rowOf('SDL (Skills Development Levy)')).toMatch(/77,00/);
    fireEvent.click(screen.getByText(/Payroll Runs \(1\)/));
    expect(await screen.findByText(/999,00/)).toBeDefined();   // run.grossPay
  });
  it('an empty 500 shows a sentence and no figures', async () => {
    serve(on('GET', 'sars-emp201', empty500));
    render(<Emp201Page />);
    fireEvent.click(screen.getByRole('button', { name: /Generate/ }));
    expect(await screen.findByText('Could not generate the EMP201 - try again')).toBeDefined();
    expect(screen.queryByText('Number of employees')).toBeNull(); expectNoJargon();
  });
});

describe('sars/index (routes: sars-compliance -> { events }, sars-submissions -> { items })', () => {
  const due = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
  const evt = { eventType: 'VAT201_DUE', dueDate: due, description: 'D2 VAT return falls due', status: 'pending' };
  const sub = { id: 's1', formType: 'D2-FORM', periodStart: '2026-07-01', periodEnd: '2026-08-31', status: 'submitted', submissionReference: 'D2-REF-77', submittedAt: null, createdAt: '2026-09-02T00:00:00Z' };
  it('success: the upcoming deadline and the recent submission are listed', async () => {
    serve(on('GET', 'sars-compliance', () => ok({ events: [evt] })), on('GET', 'sars-submissions', () => ok({ items: [sub] })));
    render(<SarsIndexPage />);
    expect(await screen.findByText('D2 VAT return falls due')).toBeDefined();
    const tr = screen.getByText('D2-FORM').closest('tr') as HTMLElement;
    expect(tr.textContent).toContain('D2-REF-77');
    expect(screen.getByText('10d')).toBeDefined();
  });
  it('an empty 500 shows a sentence and no rows', async () => {
    serve(on('GET', 'sars-compliance', empty500), on('GET', 'sars-submissions', () => ok({ items: [sub] })));
    render(<SarsIndexPage />);
    expect(await screen.findByText('Could not load the SARS data - try again')).toBeDefined();
    expect(screen.queryByText('D2-FORM')).toBeNull(); expectNoJargon();
  });
});

describe('settings/billing/compare (routes: flows/wallet -> { balance, monthFlowsUsed, monthResetAt }, plans -> Plan[])', () => {
  const wallet = { balance: 40, monthFlowsUsed: 37, monthResetAt: new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString() };
  const plan = { id: 'p1', code: 'starter', name: 'D2 Starter Plan', description: null, monthly_price_cents: 29900, currency: 'ZAR', limits: {}, display_order: 1 };
  it('success: shows the flows used and the plan being compared against', async () => {
    serve(on('GET', 'flows/wallet', () => ok(wallet)), on('GET', 'billing/plans', () => ok([plan])));
    render(<ComparePage />);
    expect((await screen.findAllByText('D2 Starter Plan')).length).toBeGreaterThan(0);
    expect(document.body.textContent).toMatch(/37 Flows used/);
  });
  it('an empty 500 shows a sentence and no comparison', async () => {
    serve(on('GET', 'flows/wallet', empty500), on('GET', 'billing/plans', () => ok([plan])));
    render(<ComparePage />);
    expect(await screen.findByText('Could not load your wallet - try again')).toBeDefined();
    expect(screen.queryByText('D2 Starter Plan')).toBeNull(); expectNoJargon();
  });
});

describe('settings/billing/flows/return (route: data = { purchaseId, status, flows, priceCents })', () => {
  beforeEach(() => { route.query = { ref: 'D2-PUR-1' }; });
  it('succeeded: confirms and names the flows added', async () => {
    serve(on('GET', 'purchase-status', () => ok({ purchaseId: 'D2-PUR-1', status: 'succeeded', flows: 120, priceCents: 12000 })));
    render(<FlowsReturnPage />);
    expect(await screen.findByText('Payment confirmed')).toBeDefined();
    expect(screen.getByText('120 Flows have been added to your wallet.')).toBeDefined();
    expect(String(vi.mocked(apiFetch).mock.calls[0]![0])).toContain('id=D2-PUR-1');
  });
  it('failed: says the payment was not completed', async () => {
    serve(on('GET', 'purchase-status', () => ok({ purchaseId: 'D2-PUR-1', status: 'failed', flows: 0, priceCents: 0 })));
    render(<FlowsReturnPage />);
    expect(await screen.findByText('Payment not completed')).toBeDefined();
  });
  it('an empty 500 shows a sentence, never "confirmed"', async () => {
    serve(on('GET', 'purchase-status', empty500));
    render(<FlowsReturnPage />);
    expect(await screen.findByText('Could not check your purchase - try again')).toBeDefined();
    expect(screen.queryByText('Payment confirmed')).toBeNull(); expectNoJargon();
  });
});

describe('settings/currencies (route: data = Currency[])', () => {
  it('success: lists code, name and symbol', async () => {
    serve(on('GET', 'accounting/currencies', () => ok([{ code: 'D2X', name: 'D2 Dollar', symbol: 'D$' }])));
    render(<CurrenciesPage />);
    const tr = (await screen.findByText('D2 Dollar')).closest('tr') as HTMLElement;
    expect(within(tr).getByText('D2X')).toBeDefined();
    expect(within(tr).getByText('D$')).toBeDefined();
  });
  it('an empty 500 shows a sentence and no rows', async () => {
    serve(on('GET', 'accounting/currencies', empty500));
    render(<CurrenciesPage />);
    expect(await screen.findByText(/Could not load (the )?currencies - try again/)).toBeDefined();
    expect(screen.queryByText('D2 Dollar')).toBeNull(); expectNoJargon();
  });
});

describe('supplier-invoices/index (routes: ?status_counts=1 -> { counts }, list -> { invoices, total })', () => {
  const inv = { id: 'si1', invoiceNumber: 'D2-SI-001', supplierName: 'D2 Supplier Ltd', reference: 'D2-REF', invoiceDate: '2026-09-01', dueDate: '2026-10-01',
    totalAmount: 321, amountPaid: 0, balance: 321, status: 'draft' };
  const counts = on('GET', 'status_counts', () => ok({ counts: { draft: 1 } }));
  it('success: the invoice row shows number, supplier, reference, amount and status', async () => {
    serve(counts, on('GET', 'supplier-invoices', () => ok({ invoices: [inv], total: 1 })));
    render(<SupplierInvoicesPage />);
    const tr = (await screen.findByText('D2-SI-001')).closest('tr') as HTMLElement;
    expect(tr.textContent).toContain('D2 Supplier Ltd');
    expect(tr.textContent).toContain('D2-REF');
    expect(tr.textContent).toMatch(/321,00/);
    await waitFor(() => expect(document.body.textContent).toMatch(/1 invoice\b/));
  });
  it('an empty 500 shows a sentence and no invoice rows', async () => {
    serve(counts, on('GET', 'supplier-invoices', empty500));
    render(<SupplierInvoicesPage />);
    expect(await screen.findByText('Could not load the supplier invoices - try again')).toBeDefined();
    expect(screen.queryByText('D2-SI-001')).toBeNull(); expectNoJargon();
  });
});
