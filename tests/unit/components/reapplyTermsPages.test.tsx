/**
 * The two Re-apply payment terms pages share one screen (components/accounting/terms): the supplier page keeps its words
 * and route, the customer page speaks of customers and invoices, calls its own route, and sends what the preview showed
 * for the ticked rows only.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/lib/apiFetch';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { ok } from '../helpers/d2CensusG4';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/accounting/supplier-invoices/SupplierSelect', () => ({ SupplierSelect: () => <div>supplier picker</div> }));
vi.mock('@/components/accounting/customer-invoices/CustomerTypeahead', () => ({ CustomerTypeahead: () => <div>customer picker</div> }));

import CustomerPage from '../../../pages/accounting/customer-invoices/reapply-terms';
import SupplierPage from '../../../pages/accounting/supplier-invoices/reapply-terms';

useApiJsonOverMock();
afterEach(() => { cleanup(); vi.mocked(apiFetch).mockReset(); });

const ROW = {
  id: 'i-1', invoiceNumber: 'INV-1', status: 'approved', invoiceDate: '2026-09-16', balance: 100, currentDueDate: '2026-10-16',
  currentSource: 'legacy', newDueDate: '2026-12-31', terms: '3 months after statement', preselected: true, note: null,
};
const HAND = { ...ROW, id: 'i-2', invoiceNumber: 'INV-2', currentSource: 'manual', preselected: false, note: 'Due date was set by hand' };
const CUSTOMER_PREVIEW = {
  rows: [{ ...ROW, customerId: 'c-1', customerName: 'Acme', currencyCode: 'ZAR' }, { ...HAND, customerId: 'c-1', customerName: 'Acme', currencyCode: 'ZAR' }],
  unchanged: 4, truncated: false, skippedCustomers: [{ customerId: 'c-2', customerName: 'NoTerms', openInvoices: 2, balance: 50 }],
};
const SUPPLIER_PREVIEW = {
  rows: [{ ...ROW, supplierId: 's-1', supplierName: 'Vendor' }], unchanged: 1, truncated: false,
  skippedSuppliers: [{ supplierId: 's-2', supplierName: 'NoTerms', openBills: 3, balance: 70 }],
};
const posts = () => vi.mocked(apiFetch).mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === 'POST');

describe('customer re-apply page', () => {
  it('lists customers\' invoices, ticks the pre-selected one, and POSTs only the ticked row as previewed', async () => {
    vi.mocked(apiFetch).mockImplementation(async (_u, init) => (init?.method === 'POST' ? ok({ updated: [{ id: 'i-1', invoiceNumber: 'INV-1', from: '2026-10-16', to: '2026-12-31' }], skipped: [] }) : ok(CUSTOMER_PREVIEW)));
    render(<CustomerPage />);
    expect(await screen.findByText('INV-1')).toBeTruthy();
    expect(vi.mocked(apiFetch).mock.calls[0]![0]).toBe('/api/accounting/customer-invoices-reapply-terms');
    expect(screen.getByRole('columnheader', { name: 'Customer' })).toBeTruthy();
    expect(screen.getByText(/2 invoices would move; 4 already match their terms/)).toBeTruthy();
    expect(screen.getByTestId('reapply-skipped').textContent).toContain('customer terms not set): NoTerms (2,');
    expect((screen.getByLabelText('Re-date INV-1') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('Re-date INV-2') as HTMLInputElement).checked).toBe(false);
    expect(screen.getByText('Due date was set by hand')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'INV-1' }).getAttribute('href')).toBe('/accounting/customer-invoices/i-1');

    fireEvent.click(screen.getByRole('button', { name: /re-date 1 invoice/i }));
    fireEvent.click(await screen.findByRole('button', { name: 'Re-date' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]![0]).toBe('/api/accounting/customer-invoices-reapply-terms');
    expect(JSON.parse(String((posts()[0]![1] as RequestInit).body))).toEqual({
      items: [{ id: 'i-1', dueDate: '2026-12-31', fromDueDate: '2026-10-16', fromSource: 'legacy' }],
    });
    expect(await screen.findByText(/Re-dated 1 invoice\./)).toBeTruthy();
  });

  it('a foreign invoice\'s owing is shown in its own currency', async () => {
    vi.mocked(apiFetch).mockResolvedValue(ok({ ...CUSTOMER_PREVIEW, rows: [{ ...CUSTOMER_PREVIEW.rows[0], currencyCode: 'USD', balance: 2300 }], skippedCustomers: [] }));
    render(<CustomerPage />);
    await screen.findByText('INV-1');
    expect(screen.getAllByText(/\$\s?2\s?300[.,]00/).length).toBeGreaterThan(0);
  });
});

describe('supplier re-apply page (unchanged words and route)', () => {
  it('speaks of suppliers and bills and calls the supplier route', async () => {
    vi.mocked(apiFetch).mockResolvedValue(ok(SUPPLIER_PREVIEW));
    render(<SupplierPage />);
    expect(await screen.findByText('INV-1')).toBeTruthy();
    expect(vi.mocked(apiFetch).mock.calls[0]![0]).toBe('/api/accounting/supplier-invoices-reapply-terms');
    expect(screen.getByRole('columnheader', { name: 'Supplier' })).toBeTruthy();
    expect(screen.getByText(/1 bill would move; 1 already match their terms/)).toBeTruthy();
    expect(screen.getByTestId('reapply-skipped').textContent).toContain('supplier terms not set): NoTerms (3,');
    expect(screen.getByRole('link', { name: 'INV-1' }).getAttribute('href')).toBe('/accounting/supplier-invoices/i-1');
    expect(screen.getByRole('button', { name: /re-date 1 bill/i })).toBeTruthy();
  });

  it('POSTs only the ticked, pre-selected bills as previewed to the supplier route', async () => {
    const preview = { ...SUPPLIER_PREVIEW, rows: [
      { ...ROW, supplierId: 's-1', supplierName: 'Vendor' }, { ...HAND, supplierId: 's-1', supplierName: 'Vendor' },
    ] };
    vi.mocked(apiFetch).mockImplementation(async (_u, init) => (init?.method === 'POST' ? ok({ updated: [{ id: 'i-1', invoiceNumber: 'INV-1', from: '2026-10-16', to: '2026-12-31' }], skipped: [{ id: 'i-9', reason: 'date_changed' }] }) : ok(preview)));
    render(<SupplierPage />);
    await screen.findByText('INV-1');
    expect((screen.getByLabelText('Re-date INV-1') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('Re-date INV-2') as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: /re-date 1 bill/i }));
    fireEvent.click(await screen.findByRole('button', { name: 'Re-date' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]![0]).toBe('/api/accounting/supplier-invoices-reapply-terms');
    expect(JSON.parse(String((posts()[0]![1] as RequestInit).body))).toEqual({
      items: [{ id: 'i-1', dueDate: '2026-12-31', fromDueDate: '2026-10-16', fromSource: 'legacy' }],
    });
    expect(await screen.findByText(/Re-dated 1 bill\. Skipped 1: due date changed since the preview\./)).toBeTruthy();
  });
});
