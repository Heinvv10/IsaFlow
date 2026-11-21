/**
 * Codex gate on PR #1703: cancelling a bill can reopen a purchase order it no longer leaves fully billed; the service returns the
 * reopened POs and a warning each. The single-bill detail page and the bulk bar must SHOW them (rendered and clicked, not grepped).
 */
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

const route = vi.hoisted(() => ({ query: {} as Record<string, string> }));
const company = vi.hoisted(() => ({ companyRole: 'owner', activeCompany: { id: 'co-1', name: 'Co' } }));
vi.mock('next/router', () => ({
  useRouter: () => ({ isReady: true, pathname: '/accounting', query: route.query, push: vi.fn(), events: { on: () => {}, off: () => {} } }),
}));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => company }));
vi.mock('@/components/accounting/ap/ThreeWayMatchPanel', () => ({ ThreeWayMatchPanel: () => null }));
vi.mock('@/modules/accounting/documents', () => ({ AccountingDocumentPanel: () => null }));
vi.mock('@/components/accounting/comments/CommentsPanel', () => ({ CommentsPanel: () => null, default: () => null }));
vi.mock('@/utils/toast', () => ({ notify: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock('@/lib/apiFetch', async (original) => ({ ...await original<typeof import('@/lib/apiFetch')>(), apiFetch: vi.fn() }));

import { apiFetch } from '@/lib/apiFetch';
import { notify } from '@/utils/toast';
import SupplierInvoiceDetailPage from '../../../pages/accounting/supplier-invoices/[invoiceId]';
import { BulkActionBar } from '@/components/accounting/supplier-invoices/BulkActionBar';

const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200, headers: { 'Content-Type': 'application/json' } });
function serve(routes: Array<[string, unknown]>) {
  vi.mocked(apiFetch).mockImplementation(async (url) => ok(routes.find(([part]) => String(url).includes(part))?.[1] ?? {}));
}
const REOPENED = 'Purchase order PO-9 reopened to approved: it is no longer fully billed, so it commits spend again.';

beforeEach(() => { vi.mocked(apiFetch).mockReset(); vi.mocked(notify.warning).mockReset(); route.query = {}; });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('supplier invoice detail: Cancel Invoice', () => {
  const invoice = {
    id: 'inv-1', invoiceNumber: 'INV-001', supplierName: 'Acme Supplies', status: 'approved', invoiceDate: '2026-03-01',
    dueDate: '2026-03-31', paymentTerms: '30 days', subtotal: 1000, taxAmount: 150, taxRate: 15, totalAmount: 1150,
    balance: 1150, amountPaid: 0, notes: '', items: [], approval: { state: 'not_required', enforced: false, requiredRole: null, ruleName: null, requestId: null },
  };
  const cancel = async (answer: unknown) => {
    route.query = { invoiceId: 'inv-1' };
    serve([['supplier-invoices-action', answer], ['supplier-invoices-detail', invoice]]);
    render(<SupplierInvoiceDetailPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'More invoice actions' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Cancel Invoice/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel Invoice' }));
    await waitFor(() => expect(vi.mocked(apiFetch).mock.calls.filter(([u]) => String(u).includes('supplier-invoices-action')).length).toBe(1));
    await waitFor(() => expect(vi.mocked(apiFetch).mock.calls.filter(([u]) => String(u).includes('supplier-invoices-detail')).length).toBe(2));
  };
  it('a cancel that reopened a PO says which, and its budget warning', async () => {
    await cancel({ ...invoice, status: 'cancelled', reopenedPurchaseOrders: [{ poId: 'p9', poNumber: 'PO-9', reopenedTo: 'approved' }], budgetWarnings: [REOPENED] });
    await waitFor(() => expect(notify.warning).toHaveBeenCalledWith('Purchase order PO-9 reopened', REOPENED));
  });
  it('a cancel that reopened nothing says nothing', async () => {
    await cancel({ ...invoice, status: 'cancelled', reopenedPurchaseOrders: [], budgetWarnings: [] });
    expect(notify.warning).not.toHaveBeenCalled();
  });
});

describe('supplier invoice bulk bar: Cancel', () => {
  it('a bulk cancel that reopened a PO says it reopened, not that a bill was approved over budget', async () => {
    vi.stubGlobal('confirm', () => true);
    serve([['supplier-invoices-bulk-action', { total: 1, succeeded: 1, failed: 0, results: [{ invoiceId: 'b1', invoiceNumber: 'INV-1', ok: true, budgetWarnings: [REOPENED] }] }]]);
    const onComplete = vi.fn(async () => {});
    render(<BulkActionBar selected={new Set(['b1'])} busy={null} onBusyChange={() => {}} onError={() => {}} onComplete={onComplete} onClear={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    await waitFor(() => expect(notify.warning).toHaveBeenCalledWith('1 bill cancelled: a purchase order reopened', REOPENED));
  });
});
