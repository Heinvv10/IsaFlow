/**
 * D2 round 3 (a4): detail pages (recurring invoice edit, delivery note, purchase order, supplier credit note,
 * expense claim). Status before body on loads, every write checked, refused writes never redirect / claim success.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { MSG, PLAIN_BAD, empty500, envelope, ok } from '../helpers/d2R3a4';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
const route = vi.hoisted(() => ({ query: { id: 'x1', poId: 'po1' } as Record<string, string>, push: vi.fn(), isReady: true }));
vi.mock('next/router', () => ({ useRouter: () => route }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));

import { apiFetch } from '@/lib/apiFetch';
import RecurringInvoiceEditPage from '../../../pages/accounting/recurring-invoices/[id]';
import DeliveryNotePage from '../../../pages/accounting/delivery-notes/[id]';
import PurchaseOrderPage from '../../../pages/accounting/purchase-orders/[poId]';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
  route.push.mockReset();
  vi.stubGlobal('confirm', vi.fn(() => true));
});
afterEach(() => { cleanup(); });

const noJsonLeak = () => expect(screen.queryByText(PLAIN_BAD)).toBeNull();
const isWrite = (init?: RequestInit) => !!init?.method && init.method !== 'GET';
const btn = (name: RegExp) => screen.getByRole('button', { name }) as HTMLButtonElement;

describe('recurring-invoices/[id]', () => {
  const ROW = { id: 'x1', templateName: 'D2 Retainer', clientId: 'c1', frequency: 'monthly', nextRunDate: '2099-01-01',
    description: '', lineItems: [{ description: 'D2 line', quantity: 1, unitPrice: 10 }] };
  const script = (list: () => Response, write: () => Response = () => ok({})) => vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    if (isWrite(init)) return write();
    return String(url).includes('/recurring-invoices') ? list() : ok([]);
  });
  const save = () => fireEvent.submit(document.querySelector('form')!);

  it('a refused load shows the server message and Save is disabled (no blank editable form to save back)', async () => {
    script(() => envelope());
    render(<RecurringInvoiceEditPage />);
    expect(await screen.findByText(MSG)).toBeTruthy();
    expect(btn(/Save Changes/).disabled).toBe(true);
  });

  it('an empty-500 load shows a plain sentence and Save is disabled', async () => {
    script(empty500);
    render(<RecurringInvoiceEditPage />);
    expect(await screen.findByText(/Could not load the recurring invoice - try again/)).toBeTruthy();
    noJsonLeak();
    expect(btn(/Save Changes/).disabled).toBe(true);
  });

  it('a template that is not in the list disables Save', async () => {
    script(() => ok({ items: [] }));
    render(<RecurringInvoiceEditPage />);
    expect(await screen.findByText('Recurring invoice not found')).toBeTruthy();
    expect(btn(/Save Changes/).disabled).toBe(true);
  });

  it('a loaded template enables Save; a refused save shows the server message and does not redirect', async () => {
    script(() => ok({ items: [ROW] }), () => envelope());
    render(<RecurringInvoiceEditPage />);
    await waitFor(() => expect(btn(/Save Changes/).disabled).toBe(false));
    save();
    expect(await screen.findByText(MSG)).toBeTruthy();
    expect(route.push).not.toHaveBeenCalled();
    await waitFor(() => expect(btn(/Save Changes/).disabled).toBe(false));
  });

  it('a save answered with an empty 500 shows a plain sentence', async () => {
    script(() => ok({ items: [ROW] }), empty500);
    render(<RecurringInvoiceEditPage />);
    await waitFor(() => expect(btn(/Save Changes/).disabled).toBe(false));
    save();
    expect(await screen.findByText(/Could not save the recurring invoice - try again/)).toBeTruthy();
    noJsonLeak();
    expect(route.push).not.toHaveBeenCalled();
  });

  it('a successful save redirects to the list', async () => {
    script(() => ok({ items: [ROW] }));
    render(<RecurringInvoiceEditPage />);
    await waitFor(() => expect(btn(/Save Changes/).disabled).toBe(false));
    save();
    await waitFor(() => expect(route.push).toHaveBeenCalledWith('/accounting/recurring-invoices'));
  });
});

describe('delivery-notes/[id]', () => {
  const NOTE = { id: 'x1', deliveryNoteNumber: 'DN-D2-1', customerName: 'D2 Customer', deliveryDate: '2026-01-01', status: 'draft', lines: [] };
  const script = (load: () => Response, write: () => Response = () => ok({})) =>
    vi.mocked(apiFetch).mockImplementation(async (_u, init) => (isWrite(init) ? write() : load()));

  it('a refused load shows the server message', async () => {
    script(() => envelope());
    render(<DeliveryNotePage />);
    expect(await screen.findByText(MSG)).toBeTruthy();
  });

  it('an empty-500 load shows a plain sentence', async () => {
    script(empty500);
    render(<DeliveryNotePage />);
    expect(await screen.findByText(/Could not load the delivery note - try again/)).toBeTruthy();
    noJsonLeak();
  });

  it('a refused dispatch shows the server message and clears busy', async () => {
    script(() => ok(NOTE), () => envelope());
    render(<DeliveryNotePage />);
    fireEvent.click(await screen.findByRole('button', { name: /Dispatch/ }));
    expect(await screen.findByText(MSG)).toBeTruthy();
    await waitFor(() => expect(btn(/Dispatch/).disabled).toBe(false));
  });

  it('a dispatch answered with an empty 500 shows a plain sentence', async () => {
    script(() => ok(NOTE), empty500);
    render(<DeliveryNotePage />);
    fireEvent.click(await screen.findByRole('button', { name: /Dispatch/ }));
    expect(await screen.findByText(/Could not update the delivery note - try again/)).toBeTruthy();
    noJsonLeak();
  });

  it('a refused cancel shows the server message and does not navigate', async () => {
    vi.stubGlobal('window', Object.assign(window, { confirm: vi.fn(() => true) }));
    script(() => ok(NOTE), () => envelope());
    render(<DeliveryNotePage />);
    fireEvent.click(await screen.findByRole('button', { name: /Cancel/ }));
    expect(await screen.findByText(MSG)).toBeTruthy();
    expect(route.push).not.toHaveBeenCalled();
  });

  it('a successful cancel navigates to the list', async () => {
    vi.stubGlobal('window', Object.assign(window, { confirm: vi.fn(() => true) }));
    script(() => ok(NOTE));
    render(<DeliveryNotePage />);
    fireEvent.click(await screen.findByRole('button', { name: /Cancel/ }));
    await waitFor(() => expect(route.push).toHaveBeenCalledWith('/accounting/delivery-notes'));
  });
});

describe('purchase-orders/[poId]', () => {
  const PO = { id: 'po1', po_number: 'PO-D2-1', supplier_id: 's1', supplier_name: 'D2 Supplier', supplier_email: null, supplier_phone: null,
    order_date: '2026-01-01', expected_delivery_date: null, status: 'draft', subtotal: 100, tax_amount: 15, total: 115, notes: null,
    reference: null, created_at: '2026-01-01T00:00:00Z', items: [] };
  const script = (load: () => Response, write: () => Response = () => ok(PO)) => vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    if (isWrite(init)) return write();
    return String(url).includes('/purchase-orders/po1') ? load() : ok([]);
  });

  it('a refused load shows the server message, not "Failed to load purchase order"', async () => {
    script(() => envelope());
    render(<PurchaseOrderPage />);
    expect(await screen.findByText(MSG)).toBeTruthy();
    expect(screen.queryByText(/^Failed to load/)).toBeNull();
  });

  it('an empty-500 load shows a plain sentence', async () => {
    script(empty500);
    render(<PurchaseOrderPage />);
    expect(await screen.findByText(/Could not load the purchase order - try again/)).toBeTruthy();
    noJsonLeak();
  });

  it('a refused save shows the server message and keeps the edit form open', async () => {
    script(() => ok(PO), () => envelope());
    render(<PurchaseOrderPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Edit/ }));
    fireEvent.click(btn(/Save Changes/));
    expect(await screen.findByText(MSG)).toBeTruthy();
    expect(btn(/Save Changes/)).toBeTruthy();
  });

  it('a save answered with an empty 500 shows a plain sentence and keeps the form', async () => {
    script(() => ok(PO), empty500);
    render(<PurchaseOrderPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Edit/ }));
    fireEvent.click(btn(/Save Changes/));
    expect(await screen.findByText(/Could not save the purchase order - try again/)).toBeTruthy();
    noJsonLeak();
    expect(btn(/Save Changes/)).toBeTruthy();
  });

  it('a successful save closes the edit form', async () => {
    script(() => ok(PO), () => ok({ ...PO, reference: 'D2-REF' }));
    render(<PurchaseOrderPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Edit/ }));
    fireEvent.click(btn(/Save Changes/));
    await waitFor(() => expect(screen.queryByRole('button', { name: /Save Changes/ })).toBeNull());
  });

  it('a delete answered with an empty 500 shows a plain sentence', async () => {
    script(() => ok(PO), empty500);
    render(<PurchaseOrderPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Delete/ }));
    expect(await screen.findByText(/Could not delete the purchase order - try again/)).toBeTruthy();
    noJsonLeak();
    expect(route.push).not.toHaveBeenCalled();
  });
});
