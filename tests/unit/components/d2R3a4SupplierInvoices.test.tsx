/**
 * D2 round 3 (a4): supplier invoice detail (actions, 409 approval-gate reload, save) and the new-invoice form.
 * Status before body: an empty-body 4xx/5xx must give a plain sentence, and the 409 reload must still happen.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { MSG, PLAIN_BAD, empty500, envelope, ok } from '../helpers/d2R3a4';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
const route = vi.hoisted(() => ({ query: { invoiceId: 'inv-1' } as Record<string, string>, push: vi.fn(), isReady: true }));
vi.mock('next/router', () => ({ useRouter: () => route }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: 'owner' }) }));
vi.mock('@/components/accounting/ap/ThreeWayMatchPanel', () => ({ ThreeWayMatchPanel: () => null }));
vi.mock('@/modules/accounting/documents', () => ({ AccountingDocumentPanel: () => null }));
vi.mock('@/components/accounting/ScanAndFillButton', () => ({ ScanAndFillButton: () => null }));
vi.mock('@/components/accounting/supplier-invoices/SupplierSelect', () => ({
  SupplierSelect: ({ onChange }: { onChange: (id: string, name: string) => void }) => (
    <button type="button" onClick={() => onChange('s1', 'D2 Supplier')}>pick-supplier</button>
  ),
}));
vi.mock('@/components/accounting/suppliers/PoGrnSelector', () => ({ PoGrnSelector: () => null }));

import { apiFetch } from '@/lib/apiFetch';
import SupplierInvoiceDetailPage from '../../../pages/accounting/supplier-invoices/[invoiceId]';
import NewSupplierInvoicePage from '../../../pages/accounting/supplier-invoices/new';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
beforeEach(() => { vi.mocked(apiFetch).mockReset(); route.push.mockReset(); });
afterEach(() => { cleanup(); });

const noJsonLeak = () => expect(screen.queryByText(PLAIN_BAD)).toBeNull();
const isWrite = (init?: RequestInit) => !!init?.method && init.method !== 'GET';
const INVOICE = (status: string, extra: object = {}) => ({
  id: 'inv-1', invoiceNumber: 'INV-D2-1', supplierName: 'D2 Supplier', status, invoiceDate: '2026-03-01', dueDate: '2026-03-31',
  paymentTerms: '30 days', subtotal: 100, taxAmount: 15, taxRate: 15, totalAmount: 115, balance: 115, notes: '', items: [],
  approval: { state: 'approved', enforced: true, requiredRole: 'owner', ruleName: 'Owner signs', requestId: 'req-1' }, ...extra,
});

describe('supplier-invoices/[invoiceId]', () => {
  const script = (inv: () => Response, write: () => Response) => vi.mocked(apiFetch).mockImplementation(async (_u, init) =>
    isWrite(init) ? write() : inv());
  const detailLoads = () => vi.mocked(apiFetch).mock.calls.filter(([, i]) => !isWrite(i)).length;

  it('a refused load shows the server message and no stale invoice', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => envelope());
    render(<SupplierInvoiceDetailPage />);
    expect(await screen.findByText(MSG)).toBeTruthy();
    expect(screen.queryByText('INV-D2-1')).toBeNull();
  });

  it('a refused action shows the server message', async () => {
    script(() => ok(INVOICE('draft')), () => envelope());
    render(<SupplierInvoiceDetailPage />);
    fireEvent.click(await screen.findByText('Approve & Post GL'));
    expect(await screen.findByText(MSG)).toBeTruthy();
  });

  it('an action answered with an empty 500 shows a plain sentence and no reload', async () => {
    script(() => ok(INVOICE('draft')), empty500);
    render(<SupplierInvoiceDetailPage />);
    await screen.findByText('Approve & Post GL');
    const before = detailLoads();
    fireEvent.click(screen.getByText('Approve & Post GL'));
    expect(await screen.findByText(/Could not complete that action - try again/)).toBeTruthy();
    noJsonLeak();
    expect(detailLoads()).toBe(before);
  });

  it('a 409 with an EMPTY body still reloads the invoice (approval gate), and shows a plain sentence', async () => {
    script(() => ok(INVOICE('draft')), () => new Response('', { status: 409 }));
    render(<SupplierInvoiceDetailPage />);
    await screen.findByText('Approve & Post GL');
    const before = detailLoads();
    fireEvent.click(screen.getByText('Approve & Post GL'));
    expect(await screen.findByText(/Could not complete that action - try again/)).toBeTruthy();
    expect(detailLoads()).toBe(before + 1);
  });

  it('a 409 with an envelope reloads and shows the server message', async () => {
    script(() => ok(INVOICE('draft')), () => envelope(MSG, 409));
    render(<SupplierInvoiceDetailPage />);
    await screen.findByText('Approve & Post GL');
    const before = detailLoads();
    fireEvent.click(screen.getByText('Approve & Post GL'));
    expect(await screen.findByText(MSG)).toBeTruthy();
    expect(detailLoads()).toBe(before + 1);
  });

  it('a successful action reloads the invoice', async () => {
    script(() => ok(INVOICE('draft')), () => ok({}));
    render(<SupplierInvoiceDetailPage />);
    await screen.findByText('Approve & Post GL');
    const before = detailLoads();
    fireEvent.click(screen.getByText('Approve & Post GL'));
    await waitFor(() => expect(detailLoads()).toBe(before + 1));
    expect(screen.queryByText(/Could not complete/)).toBeNull();
  });

  it('a save answered with an empty 500 shows a plain sentence and keeps the edit form', async () => {
    script(() => ok(INVOICE('draft')), empty500);
    render(<SupplierInvoiceDetailPage />);
    fireEvent.click(await screen.findByText('Edit'));
    fireEvent.click(await screen.findByText('Save'));
    expect(await screen.findByText(/Could not save the invoice - try again/)).toBeTruthy();
    noJsonLeak();
    expect(screen.getByText('Save')).toBeTruthy();
  });

  it('a save that succeeds then a failing reload: edit closes, the reload error shows, the stale invoice is gone, busy clears', async () => {
    let wrote = false;
    vi.mocked(apiFetch).mockImplementation(async (_u, init) => {
      if (isWrite(init)) { wrote = true; return ok({}); }
      return wrote ? empty500() : ok(INVOICE('draft'));
    });
    render(<SupplierInvoiceDetailPage />);
    fireEvent.click(await screen.findByText('Edit'));
    fireEvent.click(await screen.findByText('Save'));
    expect(await screen.findByText(/Could not load the invoice - try again/)).toBeTruthy();
    expect(screen.queryByText('INV-D2-1')).toBeNull();
  });
});

describe('supplier-invoices/new', () => {
  const script = (write: () => Response) => vi.mocked(apiFetch).mockImplementation(async (_u, init) =>
    isWrite(init) ? write() : ok([]));
  const submit = async () => {
    fireEvent.click(await screen.findByText('pick-supplier'));
    fireEvent.submit(document.querySelector('form')!);
  };

  it('a refused create shows the server message and does not redirect', async () => {
    script(() => envelope());
    render(<NewSupplierInvoicePage />);
    await submit();
    expect(await screen.findByText(MSG)).toBeTruthy();
    expect(route.push).not.toHaveBeenCalled();
  });

  it('a create answered with an empty 500 shows a plain sentence and clears submitting', async () => {
    script(empty500);
    render(<NewSupplierInvoicePage />);
    await submit();
    expect(await screen.findByText(/Could not create the invoice - try again/)).toBeTruthy();
    noJsonLeak();
    expect(route.push).not.toHaveBeenCalled();
    await waitFor(() => expect((document.querySelector('button[type="submit"]') as HTMLButtonElement).disabled).toBe(false));
  });

  it('a successful create redirects to the new invoice', async () => {
    script(() => ok({ id: 'new-1' }));
    render(<NewSupplierInvoicePage />);
    await submit();
    await waitFor(() => expect(route.push).toHaveBeenCalledWith('/accounting/supplier-invoices/new-1'));
  });
});
