// PUR-01 round 1 (part 2): returns, purchase orders, batch payments, adjustments
// and the supplier ledger. See supplierFormPayloads.test.tsx for the rule.
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { mockedFetch, router, S26, json, supplierInput, supplierId, pick, writesTo, submit, settle, writes, setExtra } from './supplierFormHarness';
import SupplierReturns from '../../../pages/accounting/supplier-returns/index';
import NewPurchaseOrder from '../../../pages/accounting/purchase-orders/new';
import PurchaseOrderDetail from '../../../pages/accounting/purchase-orders/[poId]';
import NewBatch from '../../../pages/accounting/batch-payments/new';
import Adjustments from '../../../pages/accounting/adjustments/index';
import SupplierLedger from '../../../pages/accounting/reports/supplier-ledger';

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
    await waitFor(() => expect(writesTo('/supplier-returns')[0]?.body.supplierId).toBe(S26));
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
    await waitFor(() => expect(writesTo('/purchase-orders')[0]?.body.supplierId).toBe(S26));
  });
});

describe('purchase-orders/[poId] edit', () => {
  const po = (supplier_id: string | null) => ({
    id: 'po1', po_number: 'PO-1', status: 'draft', supplier_id, supplier_name: null, supplier_email: null, supplier_phone: null,
    order_date: '2026-09-01', expected_delivery_date: null, reference: null, notes: null, subtotal: 0, tax_amount: 0, total_amount: 0, items: [],
  });
  const openEdit = async (supplier: string | null) => {
    router.query = { poId: 'po1' };
    setExtra((u) => (u.includes('/purchase-orders/po1') ? json(po(supplier)) : null));
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
    await waitFor(() => expect(writes.find((w) => w.method === 'PUT')?.body.supplier_id).toBe(S26));
  });
  it('shows the current supplier by name even though it is not in the first page', async () => {
    const { container } = await openEdit(S26);
    await waitFor(() => expect(supplierInput(container).value).toBe('Supplier One'), { timeout: 2000 });
  });
});

describe('batch-payments/new', () => {
  const invoices = { invoices: [{ id: 'i1', supplierId: S26, invoiceNumber: 'INV-1', totalAmount: 100, amountPaid: 0 }] };
  beforeEach(() => { setExtra((u) => (u.includes('supplier-invoices') ? json(invoices) : null)); });
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
    await waitFor(() => expect((writesTo('/batch-payments')[0]?.body.payments as { supplierId: string }[])[0]?.supplierId).toBe(S26));
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
    await waitFor(() => expect(writesTo('/adjustments')[0]?.body).toMatchObject({ entityType: 'supplier', entityId: S26 }));
  });
  it('a customer chosen on the customer tab is not carried into the supplier tab', async () => {
    setExtra((u) => (u.includes('/customers') ? json([{ id: 'c1', company_name: 'Cust One' }]) : null));
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
    setExtra((u) => (u.includes('reports-supplier-ledger') ? json({ supplier_name: 'Supplier One', opening_balance: 0, closing_balance: 0, transactions: [] }) : null));
    const { container } = render(<SupplierLedger />);
    await pick(container);
    fireEvent.click(screen.getByRole('button', { name: /run|generate|view/i }));
    await waitFor(() => expect(mockedFetch.mock.calls.some(([u]) => String(u).includes(`reports-supplier-ledger?supplierId=${S26}`))).toBe(true));
  });
  it('makes no ledger request without a supplier', async () => {
    render(<SupplierLedger />);
    await settle();
    expect(mockedFetch.mock.calls.some(([u]) => String(u).includes('reports-supplier-ledger'))).toBe(false);
  });
});

