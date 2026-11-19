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
