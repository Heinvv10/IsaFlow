// PUR-01 round 1 (part 1): the invoice, payment and credit-note forms that pick a
// supplier through SupplierSelect must (a) refuse to POST without one and (b) send
// the picked supplier's id. Supplier "Supplier One" is #26 of 58 alphabetically,
// i.e. beyond the route's 25-row default page, so the picker can only reach it by
// searching. Shared setup: supplierFormHarness.tsx.
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SA, SB, S26, scan, supplierId, pick, writesTo, submit, settle, supplierDelay } from './supplierFormHarness';
import NewSupplierInvoice from '../../../pages/accounting/supplier-invoices/new';
import NewSupplierPayment from '../../../pages/accounting/supplier-payments/new';
import NewCreditNote from '../../../pages/accounting/credit-notes/new';
import NewSupplierCreditNote from '../../../pages/accounting/supplier-credit-notes/new';

describe('supplier-invoices/new', () => {
  it('an OCR supplier replace drops the PO, GRN and copy-lines that belonged to the previous supplier', async () => {
    const { container } = render(<NewSupplierInvoice />);
    fireEvent.click(screen.getByText('scan-alpha'));
    await waitFor(() => expect(supplierId(container)).toBe(SA), { timeout: 2000 });
    fireEvent.click(screen.getByText('set-po'));
    fireEvent.click(screen.getByText('scan-beta'));
    await waitFor(() => expect(supplierId(container)).toBe(SB), { timeout: 2000 });
    submit(container);
    await waitFor(() => expect(writesTo('/supplier-invoices')[0]?.body).toMatchObject({ supplierId: SB }));
    const body = writesTo('/supplier-invoices')[0]!.body;
    expect(body.purchaseOrderId).toBeUndefined();
    expect(body.grnId).toBeUndefined();
  });
  it('a rescan replaces an earlier scan\'s supplier, but not one the user picked afterwards', async () => {
    const { container } = render(<NewSupplierInvoice />);
    fireEvent.click(screen.getByText('scan-alpha'));
    await waitFor(() => expect(supplierId(container)).toBe(SA), { timeout: 2000 });
    fireEvent.click(screen.getByText('scan-beta'));
    await waitFor(() => expect(supplierId(container)).toBe(SB), { timeout: 2000 });
    fireEvent.click(screen.getByLabelText(/clear supplier/i));
    await pick(container);
    expect(supplierId(container)).toBe(S26);
    fireEvent.click(screen.getByText('scan-alpha'));
    await settle(); await settle();
    expect(supplierId(container)).toBe(S26);
  });
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
    await waitFor(() => expect(writesTo('/supplier-invoices')[0]?.body.supplierId).toBe(S26));
  });
  it('an OCR match does not overwrite a supplier the user already picked', async () => {
    const { container } = render(<NewSupplierInvoice />);
    await pick(container);
    fireEvent.click(screen.getByText('scan-alpha'));
    await settle(); await settle();
    expect(supplierId(container)).toBe(S26);
  });
  it('an OCR match fills an empty supplier, and only the newest scan applies', async () => {
    Object.assign(supplierDelay, { alpha: 300 });
    const { container } = render(<NewSupplierInvoice />);
    fireEvent.click(screen.getByText('scan-alpha')); // slow
    fireEvent.click(screen.getByText('scan-beta'));  // fast, newer
    await waitFor(() => expect(supplierId(container)).toBe(SB), { timeout: 2000 });
    await act(async () => { await new Promise((r) => setTimeout(r, 500)); });
    expect(supplierId(container)).toBe(SB);
  });
});

describe('supplier-payments/new', () => {
  it('a rescan replaces an earlier scan\'s supplier, but not one the user picked afterwards', async () => {
    const { container } = render(<NewSupplierPayment />);
    fireEvent.click(screen.getByText('scan-alpha'));
    await waitFor(() => expect(supplierId(container)).toBe(SA), { timeout: 2000 });
    fireEvent.click(screen.getByText('scan-beta'));
    await waitFor(() => expect(supplierId(container)).toBe(SB), { timeout: 2000 });
    fireEvent.click(screen.getByLabelText(/clear supplier/i));
    await pick(container);
    expect(supplierId(container)).toBe(S26);
    fireEvent.click(screen.getByText('scan-alpha'));
    await settle(); await settle();
    expect(supplierId(container)).toBe(S26);
  });
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
    await waitFor(() => expect(writesTo('/supplier-payments')[0]?.body.supplierId).toBe(S26));
  });
  it('an OCR match does not overwrite a supplier the user already picked', async () => {
    const { container } = render(<NewSupplierPayment />);
    await pick(container);
    fireEvent.click(screen.getByText('scan-beta'));
    await settle(); await settle();
    expect(supplierId(container)).toBe(S26);
  });
  it('only the newest scan applies when scans resolve out of order', async () => {
    Object.assign(supplierDelay, { alpha: 300 });
    const { container } = render(<NewSupplierPayment />);
    fireEvent.click(screen.getByText('scan-alpha'));
    fireEvent.click(screen.getByText('scan-beta'));
    await waitFor(() => expect(supplierId(container)).toBe(SB), { timeout: 2000 });
    await act(async () => { await new Promise((r) => setTimeout(r, 500)); });
    expect(supplierId(container)).toBe(SB);
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
    await waitFor(() => expect(writesTo('/credit-notes')[0]?.body.supplierId).toBe(S26));
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
    await waitFor(() => expect(writesTo('/supplier-credit-notes')[0]?.body.supplierId).toBe(S26));
  });
});
