// PUR-01 round 1: every form that picks a supplier through SupplierSelect must
// (a) refuse to POST/PUT without one and (b) send the picked supplier's id.
// Supplier "Supplier One" is #26 of 58 alphabetically, i.e. beyond the route's
// 25-row default page, so the picker can only reach it by searching.
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

const router = { isReady: true, query: {} as Record<string, string>, push: vi.fn(), replace: vi.fn() };
vi.mock('next/router', () => ({ useRouter: () => router }));
vi.mock('next/link', () => ({ default: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('@/modules/accounting/documents', () => ({ AccountingDocumentPanel: () => null }));
vi.mock('@/components/accounting/suppliers/PoGrnSelector', () => ({ PoGrnSelector: () => null }));
vi.mock('@/components/accounting/ScanAndFillButton', () => ({
  ScanAndFillButton: ({ onExtracted }: { onExtracted: (d: unknown) => void }) => (
    <>
      <button type="button" onClick={() => onExtracted(scan('Alpha Traders'))}>scan-alpha</button>
      <button type="button" onClick={() => onExtracted(scan('Beta Supplies'))}>scan-beta</button>
    </>
  ),
}));
vi.mock('@/lib/apiFetch', async (original) => ({ ...await original<typeof import('@/lib/apiFetch')>(), apiFetch: vi.fn() }));

import { apiFetch } from '@/lib/apiFetch';
import NewSupplierInvoice from '../../../pages/accounting/supplier-invoices/new';
import NewSupplierPayment from '../../../pages/accounting/supplier-payments/new';
import NewCreditNote from '../../../pages/accounting/credit-notes/new';
import NewSupplierCreditNote from '../../../pages/accounting/supplier-credit-notes/new';
import SupplierReturns from '../../../pages/accounting/supplier-returns/index';
import NewPurchaseOrder from '../../../pages/accounting/purchase-orders/new';
import PurchaseOrderDetail from '../../../pages/accounting/purchase-orders/[poId]';
import NewBatch from '../../../pages/accounting/batch-payments/new';
import Adjustments from '../../../pages/accounting/adjustments/index';
import SupplierLedger from '../../../pages/accounting/reports/supplier-ledger';

const SUPPLIERS = [
  { id: 'sa', name: 'Alpha Traders', company_name: null },
  { id: 'sb', name: 'Beta Supplies', company_name: null },
  { id: 's26', name: 'Supplier One', company_name: 'Supplier One Holdings' },
];
function scan(vendorName: string) {
  return { vendorName, referenceNumber: null, date: null, dueDate: null, paymentTerms: null, vatRate: null, totalAmount: null, lineItems: [], confidence: 1, warnings: [] };
}
const json = (data: unknown, status = 200) => new Response(JSON.stringify({ success: status < 400, data }), { status });

type Write = { url: string; method: string; body: Record<string, unknown> };
let writes: Write[];
let supplierDelay: Record<string, number>;
let extra: (url: string) => Response | null;

beforeEach(() => {
  writes = []; supplierDelay = {}; extra = () => null; router.query = {}; router.push.mockReset();
  vi.mocked(apiFetch).mockImplementation(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (method !== 'GET') {
      writes.push({ url, method, body: JSON.parse(String(init?.body ?? '{}')) });
      return json(method === 'PUT' ? { id: 'po1', po_number: 'PO-1', status: 'draft', items: [] } : { id: 'new1' });
    }
    const custom = extra(url);
    if (custom) return custom;
    if (url.includes('suppliers-list')) {
      const u = new URL(url, 'http://x');
      const id = u.searchParams.get('id');
      if (id) { const s = SUPPLIERS.find((r) => r.id === id); return s ? json(s) : json({}, 404); }
      const q = (u.searchParams.get('q') ?? '').toLowerCase();
      await new Promise((r) => setTimeout(r, supplierDelay[q] ?? 0));
      return json({ suppliers: SUPPLIERS.filter((s) => s.name.toLowerCase().includes(q)), total: 3 });
    }
    if (url.includes('document-numbers')) return json([]);
    return json({});
  });
});
afterEach(() => vi.mocked(apiFetch).mockReset());

const supplierInput = (c: HTMLElement) => c.querySelector('input[name="supplierIdSearch"]') as HTMLInputElement;
const supplierId = (c: HTMLElement) => (c.querySelector('input[name="supplierId"]') as HTMLInputElement).value;
async function pick(c: HTMLElement, name = 'Supplier One') {
  fireEvent.focus(supplierInput(c));
  fireEvent.click(await screen.findByRole('button', { name }, { timeout: 2000 }));
}
const writesTo = (frag: string) => writes.filter((w) => w.url.includes(frag));
const submit = (c: HTMLElement) => fireEvent.submit(c.querySelector('form')!);
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 50)); });

describe('supplier-invoices/new', () => {
  it('does not POST without a supplier', async () => {
    const { container } = render(<NewSupplierInvoice />);
    await settle();
    submit(container);
    await settle();
    expect(writesTo('/supplier-invoices')).toEqual([]);
  });
  it('POSTs the picked supplier id', async () => {
    const { container } = render(<NewSupplierInvoice />);
    await pick(container);
    submit(container);
    await waitFor(() => expect(writesTo('/supplier-invoices')[0]?.body.supplierId).toBe('s26'));
  });
  it('an OCR match does not overwrite a supplier the user already picked', async () => {
    const { container } = render(<NewSupplierInvoice />);
    await pick(container);
    fireEvent.click(screen.getByText('scan-alpha'));
    await settle(); await settle();
    expect(supplierId(container)).toBe('s26');
  });
  it('an OCR match fills an empty supplier, and only the newest scan applies', async () => {
    supplierDelay = { alpha: 300 };
    const { container } = render(<NewSupplierInvoice />);
    fireEvent.click(screen.getByText('scan-alpha')); // slow
    fireEvent.click(screen.getByText('scan-beta'));  // fast, newer
    await waitFor(() => expect(supplierId(container)).toBe('sb'), { timeout: 2000 });
    await act(async () => { await new Promise((r) => setTimeout(r, 500)); });
    expect(supplierId(container)).toBe('sb');
  });
});

describe('supplier-payments/new', () => {
  it('does not POST without a supplier', async () => {
    const { container } = render(<NewSupplierPayment />);
    await settle();
    submit(container);
    await settle();
    expect(writesTo('/supplier-payments')).toEqual([]);
  });
  it('POSTs the picked supplier id', async () => {
    const { container } = render(<NewSupplierPayment />);
    await pick(container);
    submit(container);
    await waitFor(() => expect(writesTo('/supplier-payments')[0]?.body.supplierId).toBe('s26'));
  });
  it('an OCR match does not overwrite a supplier the user already picked', async () => {
    const { container } = render(<NewSupplierPayment />);
    await pick(container);
    fireEvent.click(screen.getByText('scan-beta'));
    await settle(); await settle();
    expect(supplierId(container)).toBe('s26');
  });
  it('only the newest scan applies when scans resolve out of order', async () => {
    supplierDelay = { alpha: 300 };
    const { container } = render(<NewSupplierPayment />);
    fireEvent.click(screen.getByText('scan-alpha'));
    fireEvent.click(screen.getByText('scan-beta'));
    await waitFor(() => expect(supplierId(container)).toBe('sb'), { timeout: 2000 });
    await act(async () => { await new Promise((r) => setTimeout(r, 500)); });
    expect(supplierId(container)).toBe('sb');
  });
});

describe('credit-notes/new (supplier)', () => {
  const asSupplier = (c: HTMLElement) => fireEvent.change(c.querySelector('select[name="type"]')!, { target: { value: 'supplier' } });
  it('does not POST without a supplier', async () => {
    const { container } = render(<NewCreditNote />);
    asSupplier(container);
    submit(container);
    await settle();
    expect(writesTo('/credit-notes')).toEqual([]);
  });
  it('POSTs the picked supplier id', async () => {
    const { container } = render(<NewCreditNote />);
    asSupplier(container);
    await pick(container);
    submit(container);
    await waitFor(() => expect(writesTo('/credit-notes')[0]?.body.supplierId).toBe('s26'));
  });
});

describe('supplier-credit-notes/new', () => {
  it('does not POST without a supplier', async () => {
    const { container } = render(<NewSupplierCreditNote />);
    submit(container);
    await settle();
    expect(writesTo('/supplier-credit-notes')).toEqual([]);
  });
  it('POSTs the picked supplier id, labelled by company name', async () => {
    const { container } = render(<NewSupplierCreditNote />);
    await pick(container, 'Supplier One Holdings');
    fireEvent.change(screen.getByPlaceholderText('Item description'), { target: { value: 'Return' } });
    fireEvent.change(screen.getAllByRole('spinbutton')[1]!, { target: { value: '10' } });
    submit(container);
    await waitFor(() => expect(writesTo('/supplier-credit-notes')[0]?.body.supplierId).toBe('s26'));
  });
});

describe('supplier-returns', () => {
  const open = async () => { const r = render(<SupplierReturns />); fireEvent.click((await screen.findAllByText('New Return'))[0]!); return r; };
  it('does not POST without a supplier', async () => {
    const { container } = await open();
    fireEvent.change(container.querySelector('input[type="number"]')!, { target: { value: '50' } });
    submit(container);
    await settle();
    expect(writesTo('/supplier-returns')).toEqual([]);
  });
  it('POSTs the picked supplier id, labelled by company name', async () => {
    const { container } = await open();
    await pick(container, 'Supplier One Holdings');
    fireEvent.change(container.querySelector('input[type="number"]')!, { target: { value: '50' } });
    submit(container);
    await waitFor(() => expect(writesTo('/supplier-returns')[0]?.body.supplierId).toBe('s26'));
  });
});

describe('purchase-orders/new', () => {
  it('does not POST without a supplier', async () => {
    const { container } = render(<NewPurchaseOrder />);
    submit(container);
    await settle();
    expect(writesTo('/purchase-orders')).toEqual([]);
  });
  it('POSTs the picked supplier id', async () => {
    const { container } = render(<NewPurchaseOrder />);
    await pick(container);
    submit(container);
    await waitFor(() => expect(writesTo('/purchase-orders')[0]?.body.supplierId).toBe('s26'));
  });
});

describe('purchase-orders/[poId] edit', () => {
  const po = (supplier_id: string | null) => ({
    id: 'po1', po_number: 'PO-1', status: 'draft', supplier_id, supplier_name: null, supplier_email: null, supplier_phone: null,
    order_date: '2026-09-01', expected_delivery_date: null, reference: null, notes: null, subtotal: 0, tax_amount: 0, total_amount: 0, items: [],
  });
  const openEdit = async (supplier: string | null) => {
    router.query = { poId: 'po1' };
    extra = (u) => (u.includes('/purchase-orders/po1') ? json(po(supplier)) : null);
    const r = render(<PurchaseOrderDetail />);
    fireEvent.click(await screen.findByText('Edit'));
    return r;
  };
  it('does not PUT without a supplier', async () => {
    await openEdit(null);
    fireEvent.click(screen.getByText('Save Changes'));
    await settle();
    expect(writes.filter((w) => w.method === 'PUT')).toEqual([]);
  });
  it('PUTs the picked supplier id', async () => {
    const { container } = await openEdit(null);
    await pick(container);
    fireEvent.click(screen.getByText('Save Changes'));
    await waitFor(() => expect(writes.find((w) => w.method === 'PUT')?.body.supplier_id).toBe('s26'));
  });
  it('shows the current supplier by name even though it is not in the first page', async () => {
    const { container } = await openEdit('s26');
    await waitFor(() => expect(supplierInput(container).value).toBe('Supplier One'), { timeout: 2000 });
  });
});

describe('batch-payments/new', () => {
  const invoices = { invoices: [{ id: 'i1', supplierId: 's26', invoiceNumber: 'INV-1', totalAmount: 100, amountPaid: 0 }] };
  beforeEach(() => { extra = (u) => (u.includes('supplier-invoices') ? json(invoices) : null); });
  it('does not POST when no line has a supplier', async () => {
    const { container } = render(<NewBatch />);
    await settle();
    submit(container);
    await settle();
    expect(writesTo('/batch-payments')).toEqual([]);
  });
  it('POSTs the picked supplier id for the line', async () => {
    const { container } = render(<NewBatch />);
    await pick(container, 'Supplier One Holdings');
    await screen.findByText(/INV-1/);
    fireEvent.change(container.querySelector('select[name="invoiceId"]')!, { target: { value: 'i1' } });
    fireEvent.change(container.querySelector('input[name="amount"]')!, { target: { value: '50' } });
    submit(container);
    await waitFor(() => expect((writesTo('/batch-payments')[0]?.body.payments as { supplierId: string }[])[0]?.supplierId).toBe('s26'));
  });
});

describe('adjustments (supplier tab)', () => {
  const openForm = async () => {
    router.query = { type: 'supplier' };
    const r = render(<Adjustments />);
    fireEvent.click(await screen.findByText('New Adjustment'));
    return r;
  };
  const fill = (c: HTMLElement) => {
    fireEvent.change(c.querySelector('input[type="number"]')!, { target: { value: '5' } });
    fireEvent.change(screen.getByPlaceholderText('Reason *'), { target: { value: 'fix' } });
  };
  it('does not POST without a supplier', async () => {
    const { container } = await openForm();
    fill(container);
    submit(container);
    await settle();
    expect(writesTo('/adjustments')).toEqual([]);
  });
  it('POSTs the picked supplier id', async () => {
    const { container } = await openForm();
    await pick(container);
    fill(container);
    submit(container);
    await waitFor(() => expect(writesTo('/adjustments')[0]?.body).toMatchObject({ entityType: 'supplier', entityId: 's26' }));
  });
  it('a customer chosen on the customer tab is not carried into the supplier tab', async () => {
    extra = (u) => (u.includes('/customers') ? json([{ id: 'c1', company_name: 'Cust One' }]) : null);
    router.query = { type: 'customer' };
    const { container, rerender } = render(<Adjustments />);
    fireEvent.click(await screen.findByText('New Adjustment'));
    await screen.findByText('Cust One');
    fireEvent.change(container.querySelector('select.ff-select')!, { target: { value: 'c1' } });
    router.query = { type: 'supplier' };
    rerender(<Adjustments />);
    await settle();
    fill(container);
    submit(container);
    await settle();
    expect(writesTo('/adjustments')).toEqual([]);
  });
});

describe('reports/supplier-ledger', () => {
  it('requests the ledger for the picked supplier id', async () => {
    extra = (u) => (u.includes('reports-supplier-ledger') ? json({ supplier_name: 'Supplier One', opening_balance: 0, closing_balance: 0, transactions: [] }) : null);
    const { container } = render(<SupplierLedger />);
    await pick(container);
    fireEvent.click(screen.getByRole('button', { name: /run|generate|view/i }));
    await waitFor(() => expect(vi.mocked(apiFetch).mock.calls.some(([u]) => String(u).includes('reports-supplier-ledger?supplierId=s26'))).toBe(true));
  });
  it('makes no ledger request without a supplier', async () => {
    render(<SupplierLedger />);
    await settle();
    expect(vi.mocked(apiFetch).mock.calls.some(([u]) => String(u).includes('reports-supplier-ledger'))).toBe(false);
  });
});
