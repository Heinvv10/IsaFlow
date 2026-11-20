/**
 * #1685: the supplier / customer allocation pages must read the invoice list the way the API really returns it.
 * Supplier list: camelCase totalAmount / amountPaid / balance / invoiceDate (no total / outstanding / date).
 * Customer list: /customer-invoices-list, snake_case invoice_number / total_amount / amount_paid / invoice_date, string amounts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { ok, on, serve } from '../helpers/d2R3a6';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, push: vi.fn(), replace: vi.fn(), isReady: true, pathname: '/' }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));

import { apiFetch } from '@/lib/apiFetch';
import SupplierAllocationsPage from '../../../pages/accounting/supplier-allocations';
import CustomerAllocationsPage from '../../../pages/accounting/customer-allocations';
import WriteOffsPage from '../../../pages/accounting/write-offs';
import { customerOpenRows, supplierOpenRows } from '@/components/accounting/allocations/openInvoiceRows';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
beforeEach(() => { vi.mocked(apiFetch).mockReset(); });
afterEach(cleanup);

const SUPPLIER_BILLS = [
  { id: 'i1', invoiceNumber: 'INV-1', supplierId: 's1', invoiceDate: '2026-10-01', totalAmount: '230.00', amountPaid: '115.00', balance: '115.00', status: 'approved' },
  { id: 'i2', invoiceNumber: 'INV-2', supplierId: 's1', invoiceDate: '2026-10-02', totalAmount: '0.30', amountPaid: '0.10', balance: '0.20', status: 'approved' },
];
const CUSTOMER_INVOICES = [
  { id: 'c1', invoice_number: 'CI-1', client_id: 'k1', invoice_date: '2026-10-01', total_amount: '230.00', amount_paid: '115.00', status: 'sent' },
  { id: 'c2', invoice_number: 'CI-2', client_id: 'k1', invoice_date: '2026-10-02', total_amount: '0.30', amount_paid: '0.10', status: 'sent' },
];

describe('supplier-allocations', () => {
  it('ticking a bill pre-fills its balance, not NaN, and shows the invoice date', async () => {
    serve(
      on('GET', '/api/accounting/supplier-payments', () => ok({ payments: [{ id: 'p1', paymentNumber: 'PAY-1', supplierName: 'Sup', supplierId: 's1', date: '2026-11-01', totalAmount: 500, allocatedAmount: 0 }] })),
      on('GET', '/api/accounting/supplier-invoices', () => ok({ invoices: SUPPLIER_BILLS, total: 2 })),
    );
    render(<SupplierAllocationsPage />);
    fireEvent.click(await screen.findByText('PAY-1'));
    await screen.findByText('INV-1');
    const boxes = screen.getAllByRole('checkbox');
    fireEvent.click(boxes[0]!);
    fireEvent.click(boxes[1]!);
    expect((screen.getByRole('textbox', { name: 'Allocate to INV-1' }) as HTMLInputElement).value).toBe('115');
    expect((screen.getByRole('textbox', { name: 'Allocate to INV-2' }) as HTMLInputElement).value).toBe('0.2');
    expect(document.body.textContent).not.toMatch(/NaN/);
    await waitFor(() => expect(screen.getByRole('button', { name: /Allocate/ })).toBeTruthy());
    expect(document.body.textContent).toMatch(/1 Oct 2026|2026-10-01|01 Oct 2026/);
  });
});

describe('customer-allocations', () => {
  it('loads the invoices from customer-invoices-list and pre-fills each balance in cents', async () => {
    serve(
      on('GET', '/api/accounting/customer-payments', () => ok({ payments: [{ id: 'r1', paymentNumber: 'REC-1', clientName: 'Cust', clientId: 'k1', date: '2026-11-01', totalAmount: 500, allocatedAmount: 0 }] })),
      on('GET', '/api/accounting/customer-invoices-list', () => ok({ invoices: CUSTOMER_INVOICES, total: 2 })),
    );
    render(<CustomerAllocationsPage />);
    fireEvent.click(await screen.findByText('REC-1'));
    await screen.findByText('CI-1');
    const urls = vi.mocked(apiFetch).mock.calls.map(([u]) => String(u));
    expect(urls.some(u => u.includes('/api/accounting/customer-invoices-list?') && u.includes('client_id=k1'))).toBe(true);
    const boxes = screen.getAllByRole('checkbox');
    fireEvent.click(boxes[0]!);
    fireEvent.click(boxes[1]!);
    expect((screen.getByRole('textbox', { name: 'Allocate to CI-1' }) as HTMLInputElement).value).toBe('115');
    expect((screen.getByRole('textbox', { name: 'Allocate to CI-2' }) as HTMLInputElement).value).toBe('0.2');
    expect(document.body.textContent).not.toMatch(/NaN/);
  });
});

describe('openInvoiceRows', () => {
  it('supplier: balance in cents; falls back to total - paid; drops settled and unreadable rows', () => {
    const rows = supplierOpenRows([
      ...SUPPLIER_BILLS,
      { id: 'x', invoiceNumber: 'NOBAL', invoiceDate: '2026-10-03', totalAmount: '0.30', amountPaid: '0.10' }, // 0.3 - 0.1 = 0.19999999999999998 in floats
      { id: 'z', invoiceNumber: 'PAID', totalAmount: '10.00', amountPaid: '10.00', balance: '0.00' },
      { id: 'bad', invoiceNumber: 'BAD' },
    ]);
    expect(rows.map(r => [r.invoiceNumber, r.outstanding])).toEqual([['INV-1', 115], ['INV-2', 0.2], ['NOBAL', 0.2]]);
    expect(rows[0]).toMatchObject({ date: '2026-10-01', total: 230 });
  });
  it('supplier: the API balance wins over total - paid (a credit note can lower it)', () => {
    const rows = supplierOpenRows([{ id: 'c', invoiceNumber: 'CRD', invoiceDate: '2026-10-04', totalAmount: '100.00', amountPaid: '0.00', balance: '60.00' }]);
    expect(rows[0]?.outstanding).toBe(60);
  });
  it('customer: total_amount - amount_paid in cents', () => {
    const rows = customerOpenRows(CUSTOMER_INVOICES);
    expect(rows.map(r => [r.invoiceNumber, r.total, r.outstanding])).toEqual([['CI-1', 230, 115], ['CI-2', 0.3, 0.2]]);
  });
});

// ---- #1685 follow-up: every open status, every page, no silent drop ----
import { fetchAllPages } from '@/components/accounting/allocations/openInvoiceFetch';

const calls = () => vi.mocked(apiFetch).mock.calls.map(([u]) => String(u));
const supplierPayment = on('GET', '/api/accounting/supplier-payments', () => ok({ payments: [{ id: 'p1', paymentNumber: 'PAY-1', supplierName: 'Sup', supplierId: 's1', paymentDate: '2026-11-01', totalAmount: 500, allocatedAmount: 0 }] }));
const customerPayment = on('GET', '/api/accounting/customer-payments', () => ok({ payments: [{ id: 'r1', paymentNumber: 'REC-1', clientName: 'Cust', clientId: 'k1', paymentDate: '2026-11-01', totalAmount: 500, allocatedAmount: 0 }] }));
const bill = (n: number, status = 'approved') => ({ id: `b${n}`, invoiceNumber: `B-${n}`, invoiceDate: '2026-10-01', totalAmount: '10.00', amountPaid: '0.00', balance: '10.00', status });
const urlParam = (u: string, k: string) => new URL(u, 'http://x').searchParams.get(k);

describe('supplier-allocations: statuses and paging', () => {
  it('asks for approved AND partially_paid at limit 200, and lists the partially paid bill with its balance', async () => {
    serve(supplierPayment, (u, m) => {
      if (m !== 'GET' || !u.includes('/api/accounting/supplier-invoices')) return undefined;
      return urlParam(u, 'status') === 'partially_paid'
        ? ok({ invoices: [{ ...bill(2, 'partially_paid'), totalAmount: '100.00', amountPaid: '40.00', balance: '60.00' }], total: 1 })
        : ok({ invoices: [bill(1)], total: 1 });
    });
    render(<SupplierAllocationsPage />);
    fireEvent.click(await screen.findByText('PAY-1'));
    await screen.findByText('B-2');
    const inv = calls().filter(u => u.includes('/supplier-invoices'));
    expect(inv.map(u => urlParam(u, 'status')).sort()).toEqual(['approved', 'partially_paid']);
    expect(inv.every(u => urlParam(u, 'limit') === '200' && urlParam(u, 'supplier_id') === 's1')).toBe(true);
    fireEvent.click(screen.getAllByRole('checkbox')[1]!);
    expect((screen.getByRole('textbox', { name: 'Allocate to B-2' }) as HTMLInputElement).value).toBe('60');
    expect(document.body.textContent).toMatch(/Nov 2026/); // the payment row carries its date (paymentDate)
  });

  it('pages past 200: 201 approved bills take two requests (offset 0, 200) and all 201 are listed', async () => {
    const all = Array.from({ length: 201 }, (_, i) => bill(i));
    serve(supplierPayment, (u, m) => {
      if (m !== 'GET' || !u.includes('/api/accounting/supplier-invoices')) return undefined;
      if (urlParam(u, 'status') !== 'approved') return ok({ invoices: [], total: 0 });
      const off = Number(urlParam(u, 'offset'));
      return ok({ invoices: all.slice(off, off + 200), total: 201 });
    });
    render(<SupplierAllocationsPage />);
    fireEvent.click(await screen.findByText('PAY-1'));
    await screen.findByText('B-200');
    expect(screen.getAllByRole('checkbox')).toHaveLength(201);
    expect(calls().filter(u => u.includes('status=approved')).map(u => urlParam(u, 'offset'))).toEqual(['0', '200']);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a list that cannot be read to the end says "Showing N of M" instead of dropping rows silently', async () => {
    serve(supplierPayment, (u, m) => {
      if (m !== 'GET' || !u.includes('/api/accounting/supplier-invoices')) return undefined;
      if (urlParam(u, 'status') !== 'approved') return ok({ invoices: [], total: 0 });
      const off = Number(urlParam(u, 'offset'));
      return ok({ invoices: Array.from({ length: 200 }, (_, i) => bill(off + i)), total: 1_000_000 });
    });
    render(<SupplierAllocationsPage />);
    fireEvent.click(await screen.findByText('PAY-1'));
    expect((await screen.findByRole('alert')).textContent).toMatch(/Showing 5000 of 1000000/);
  });
});

describe('customer-allocations: paging', () => {
  it('asks for every open status at limit 100 and pages past 100 (page=1, page=2)', async () => {
    const all = Array.from({ length: 101 }, (_, i) => ({ ...CUSTOMER_INVOICES[0]!, id: `c${i}`, invoice_number: `CI-${i}` }));
    serve(customerPayment, (u, m) => {
      if (m !== 'GET' || !u.includes('/api/accounting/customer-invoices-list')) return undefined;
      const page = Number(urlParam(u, 'page'));
      return ok({ invoices: all.slice((page - 1) * 100, page * 100), total: 101 });
    });
    render(<CustomerAllocationsPage />);
    fireEvent.click(await screen.findByText('REC-1'));
    await screen.findByText('CI-100');
    expect(screen.getAllByRole('checkbox')).toHaveLength(101);
    const urls = calls().filter(u => u.includes('customer-invoices-list'));
    expect(urls.map(u => urlParam(u, 'page'))).toEqual(['1', '2']);
    expect(new URL(urls[0]!, 'http://x').searchParams.getAll('status')).toEqual(['approved', 'sent', 'partially_paid', 'overdue']);
    expect(urls.every(u => urlParam(u, 'limit') === '100')).toBe(true);
    expect(document.body.textContent).toMatch(/Nov 2026/);
  });
});

describe('fetchAllPages', () => {
  it('stops at total, at an empty page, and flags a cut-off at the cap', async () => {
    const mk = (n: number) => Array.from({ length: n }, (_, i) => ({ id: String(i) }));
    expect(await fetchAllPages(async i => ({ rows: mk(i === 0 ? 2 : 1), total: 3 }))).toMatchObject({ total: 3, truncated: false });
    expect((await fetchAllPages(async i => ({ rows: i === 0 ? mk(2) : [], total: 9 }))).truncated).toBe(false);
    expect((await fetchAllPages(async () => ({ rows: mk(2), total: 99 }), 3))).toMatchObject({ truncated: true });
  });
});

describe('write-offs: the invoice picker', () => {
  it('reads customer-invoices-list (the old /api/customer-invoices is a 404) and lists the open invoice', async () => {
    serve(
      on('GET', '/api/accounting/customers', () => ok([{ id: 'k1', company_name: 'Cust One' }])),
      on('GET', '/api/accounting/write-offs', () => ok([])),
      on('GET', '/api/accounting/customer-invoices-list', () => ok({ invoices: CUSTOMER_INVOICES, total: 2 })),
    );
    render(<WriteOffsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /new|add|write.?off/i }));
    const clientSelect = (await screen.findAllByRole('combobox'))[0] as HTMLSelectElement;
    await screen.findByRole('option', { name: /Cust One/ });
    fireEvent.change(clientSelect, { target: { value: 'k1' } });
    await screen.findByRole('option', { name: /CI-1/ });
    const urls = calls().filter(u => u.includes('customer-invoices'));
    expect(urls.every(u => u.startsWith('/api/accounting/customer-invoices-list?'))).toBe(true);
    expect(urls.some(u => u.includes('client_id=k1'))).toBe(true);
  });
});
