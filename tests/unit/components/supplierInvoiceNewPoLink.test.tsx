// The new-bill page with the real PO selector: what "Copy line items from PO" actually POSTs.
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

vi.mock('next/router', () => ({ useRouter: () => ({ isReady: true, query: {}, push: vi.fn(), replace: vi.fn() }) }));
vi.mock('next/link', () => ({ default: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('@/components/accounting/ScanAndFillButton', () => ({
  ScanAndFillButton: ({ onExtracted }: { onExtracted: (d: unknown) => void }) => (
    <button type="button" onClick={() => onExtracted({
      vendorName: null, referenceNumber: null, date: null, dueDate: null, purchaseOrderRef: null, vatRate: null, paymentTerms: null,
      confidence: 0.9, lineItems: [{ description: 'Scanned', quantity: 1, unitPrice: 5 }],
    })}>scan</button>
  ),
}));
vi.mock('@/components/accounting/supplier-invoices/SupplierSelect', () => ({
  SupplierSelect: ({ onChange }: { onChange: (id: string) => void }) => (
    <>
      <button type="button" onClick={() => onChange('s1')}>pick-supplier</button>
      <button type="button" onClick={() => onChange('s2')}>pick-other-supplier</button>
    </>
  ),
}));
vi.mock('@/lib/apiFetch', async (original) => ({ ...await original<typeof import('@/lib/apiFetch')>(), apiFetch: vi.fn() }));

import { apiFetch } from '@/lib/apiFetch';
import NewSupplierInvoice from '../../../pages/accounting/supplier-invoices/new';

const json = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const PO = {
  id: 'po-a', status: 'approved',
  items: [{
    id: 'item-1', description: 'Router', quantity: 1, unit_price: 200, tax_rate: 15, gl_account_id: 'acc-5500',
    account_code: '5500', account_name: 'Equipment Costs', cc1_id: 'ops', cc2_id: null, bu_id: null,
  }],
};
let posted: Array<Record<string, unknown>> = [];
let holdPo: Promise<void> | null = null;

beforeEach(() => {
  posted = [];
  holdPo = null;
  vi.mocked(apiFetch).mockImplementation(async (input, init) => {
    const url = String(input);
    if (init?.method === 'POST') { posted.push(JSON.parse(String(init.body))); return json({ id: 'new' }); }
    if (url.includes('/purchase-orders/unmatched')) {
      return json({
        pos: [
          { id: 'po-a', po_number: 'PO-A', order_date: '2026-11-01', status: 'approved', total: 200 },
          { id: 'po-b', po_number: 'PO-B', order_date: '2026-11-02', status: 'approved', total: 90 },
        ],
        grns: [],
      });
    }
    if (url.includes('/purchase-orders/po-a')) { await holdPo; return json(PO); }
    if (url.includes('chart-of-accounts')) return json([{ id: 'acc-5500', accountCode: '5500', accountName: 'Equipment Costs' }]);
    if (url.includes('document-numbers')) return json([{ documentType: 'supplier_invoice', prefix: 'SIV', nextNumber: 1, padding: 4 }]);
    return json({});
  });
});
afterEach(() => vi.mocked(apiFetch).mockReset());

async function copyFromPo(container: HTMLElement) {
  fireEvent.click(screen.getByText('pick-supplier'));
  const poSelect = await waitFor(() => {
    const s = [...container.querySelectorAll('select')].find((e) => [...e.options].some((o) => o.value === 'po-a'));
    expect(s).toBeTruthy();
    return s as HTMLSelectElement;
  });
  fireEvent.change(poSelect, { target: { value: 'po-a' } });
  fireEvent.click(await screen.findByLabelText(/Copy line items from PO/));
  await screen.findByDisplayValue('Router');
  return poSelect;
}
const items = () => posted[0]?.items as Array<Record<string, unknown>>;

describe('a bill whose lines were copied from a PO', () => {
  it('POSTs each line\'s PO line id, account and CC1, and shows the account instead of the default', async () => {
    const { container } = render(<NewSupplierInvoice />);
    await copyFromPo(container);
    expect((screen.getByLabelText('Line 1 account') as HTMLSelectElement).value).toBe('acc-5500');
    fireEvent.submit(container.querySelector('form')!);
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]?.purchaseOrderId).toBe('po-a');
    expect(items()[0]).toMatchObject({ poItemId: 'item-1', glAccountId: 'acc-5500', cc1Id: 'ops' });
  });

  it('drops the link when the copy is unticked: the lines stay, as the user\'s own', async () => {
    const { container } = render(<NewSupplierInvoice />);
    await copyFromPo(container);
    fireEvent.click(screen.getByLabelText(/Copy line items from PO/));
    fireEvent.submit(container.querySelector('form')!);
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(items()[0]?.description).toBe('Router');
    expect(items()[0]?.poItemId).toBeUndefined();
  });

  it('drops the link when another PO is chosen: the server would refuse a line of the first PO', async () => {
    const { container } = render(<NewSupplierInvoice />);
    const poSelect = await copyFromPo(container);
    fireEvent.change(poSelect, { target: { value: 'po-b' } });
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    fireEvent.submit(container.querySelector('form')!);
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]?.purchaseOrderId).toBe('po-b');
    expect(items()[0]?.poItemId).toBeUndefined();
  });

  it('keeps the link when the line is edited', async () => {
    const { container } = render(<NewSupplierInvoice />);
    await copyFromPo(container);
    fireEvent.change(screen.getByDisplayValue('Router'), { target: { value: 'Router, part delivery' } });
    fireEvent.submit(container.querySelector('form')!);
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(items()[0]).toMatchObject({ description: 'Router, part delivery', poItemId: 'item-1' });
  });

  it('links again when the copy is unticked and ticked', async () => {
    const { container } = render(<NewSupplierInvoice />);
    await copyFromPo(container);
    const box = screen.getByLabelText(/Copy line items from PO/) as HTMLInputElement;
    fireEvent.click(box);
    fireEvent.click(box);
    await waitFor(() => expect(box.checked).toBe(true));
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    fireEvent.submit(container.querySelector('form')!);
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(items()[0]?.poItemId).toBe('item-1');
  });

  it('drops the link and the PO when the supplier changes', async () => {
    const { container } = render(<NewSupplierInvoice />);
    await copyFromPo(container);
    fireEvent.click(screen.getByText('pick-other-supplier'));
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    fireEvent.submit(container.querySelector('form')!);
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]?.purchaseOrderId).toBeUndefined();
    expect(items()[0]?.poItemId).toBeUndefined();
  });

  it('a scan replacing the copied lines unticks the copy, so the form does not claim them', async () => {
    const { container } = render(<NewSupplierInvoice />);
    await copyFromPo(container);
    fireEvent.click(screen.getByText('scan'));
    await screen.findByDisplayValue('Scanned');
    expect((screen.getByLabelText(/Copy line items from PO/) as HTMLInputElement).checked).toBe(false);
  });

  it('ignores a copy that answers after it was unticked: the lines typed since stay', async () => {
    let release = () => {};
    holdPo = new Promise((r) => { release = r; });
    const { container } = render(<NewSupplierInvoice />);
    fireEvent.click(screen.getByText('pick-supplier'));
    const poSelect = await waitFor(() => {
      const select = [...container.querySelectorAll('select')].find((e) => [...e.options].some((o) => o.value === 'po-a'));
      expect(select).toBeTruthy();
      return select as HTMLSelectElement;
    });
    fireEvent.change(poSelect, { target: { value: 'po-a' } });
    const box = await screen.findByLabelText(/Copy line items from PO/);
    fireEvent.click(box);
    fireEvent.click(box);
    await act(async () => { release(); await new Promise((r) => setTimeout(r, 30)); });
    expect(screen.queryByDisplayValue('Router')).toBeNull();
  });

  it('ignores a copy that answers after the PO changed', async () => {
    let release = () => {};
    holdPo = new Promise((r) => { release = r; });
    const { container } = render(<NewSupplierInvoice />);
    fireEvent.click(screen.getByText('pick-supplier'));
    const poSelect = await waitFor(() => {
      const select = [...container.querySelectorAll('select')].find((e) => [...e.options].some((o) => o.value === 'po-a'));
      expect(select).toBeTruthy();
      return select as HTMLSelectElement;
    });
    fireEvent.change(poSelect, { target: { value: 'po-a' } });
    fireEvent.click(await screen.findByLabelText(/Copy line items from PO/));
    fireEvent.change(poSelect, { target: { value: 'po-b' } });
    await act(async () => { release(); await new Promise((r) => setTimeout(r, 30)); });
    expect(screen.queryByDisplayValue('Router')).toBeNull();
  });

  it('a line typed by hand carries no link', async () => {
    const { container } = render(<NewSupplierInvoice />);
    fireEvent.click(screen.getByText('pick-supplier'));
    fireEvent.submit(container.querySelector('form')!);
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(items()[0]?.poItemId).toBeUndefined();
  });
});
