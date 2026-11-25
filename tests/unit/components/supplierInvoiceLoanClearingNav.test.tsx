/**
 * P4-E, fix round 3 (b): the bill page keeps a loan clearing's result FOR THE BILL IT CLEARED. Navigating from bill A to bill B (the same page
 * component, a new `invoiceId`) must never hand A's "Cleared" result to B's panel, not even for the one render before an effect resets it;
 * and an in-page action on the bill (cancel) drops it. The panel is recorded here (its own tests are intercompanyLoanClearing.test.tsx and
 * supplierInvoiceLoanClearingPage.test.tsx), so every render's props are seen.
 */
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import type { LoanClearResult } from '@/modules/accounting/services/intercompany/payerLoanClearTypes';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
useApiJsonOverMock();
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: 'owner' }) }));
vi.mock('@/utils/toast', () => ({ notify: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
const router = { query: { invoiceId: 'inv-1' } as Record<string, string>, push: vi.fn() };
vi.mock('next/router', () => ({ useRouter: () => router }));
vi.mock('@/components/layout/AppLayout', () => ({
  AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/components/accounting/ap/ThreeWayMatchPanel', () => ({ ThreeWayMatchPanel: () => null }));
vi.mock('@/modules/accounting/documents', () => ({ AccountingDocumentPanel: () => null }));
vi.mock('@/components/accounting/comments/CommentsPanel', () => ({ CommentsPanel: () => null }));
type PanelProps = { billId: string; cleared: LoanClearResult | null; onCleared: (out: LoanClearResult) => void };
const seen: { billId: string; cleared: string | null }[] = [];
let latest: PanelProps | null = null;
vi.mock('@/components/accounting/intercompany/LoanClearingPanel', () => ({
  LoanClearingPanel: (p: PanelProps) => {
    seen.push({ billId: p.billId, cleared: p.cleared?.billId ?? null });
    latest = p;
    return p.cleared ? <p>Cleared: payment {p.cleared.paymentNumber} posted</p> : null;
  },
}));

import { apiFetch } from '@/lib/apiFetch';
import SupplierInvoiceDetailPage from '../../../pages/accounting/supplier-invoices/[invoiceId]';

const fetchMock = apiFetch as unknown as ReturnType<typeof vi.fn>;
const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const bill = (id: string) => ({
  id, invoiceNumber: `BILL-${id}`, supplierName: 'Velocity Fibre', status: 'approved', invoiceDate: '2026-09-01', dueDate: '2026-10-01',
  paymentTerms: '30 days', subtotal: 1000, taxAmount: 150, taxRate: 15, totalAmount: 1150, amountPaid: 0, balance: 1150, notes: '', items: [],
});
const result = (billId: string): LoanClearResult => ({ cleared: true, billId, paymentId: 'pay-1', paymentNumber: 'SP-00042', journalEntryId: 'je-9', messageId: 'm-1' });

beforeEach(() => {
  seen.length = 0;
  latest = null;
  router.query = { invoiceId: 'inv-1' };
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: unknown) => {
    const u = String(url);
    if (u.includes('supplier-invoices-detail')) return ok(bill(new URL(u, 'http://x').searchParams.get('id') ?? ''));
    return ok({});
  });
});

describe('supplier bill page: the loan clearing result belongs to its bill', () => {
  it('A cleared, then navigating to B: B\'s panel is never handed A\'s result (no stale banner, not even for one render)', async () => {
    const view = render(<SupplierInvoiceDetailPage />);
    await screen.findByRole('heading', { name: 'BILL-inv-1' });
    act(() => { latest!.onCleared(result('inv-1')); });
    expect(await screen.findByText(/Cleared: payment SP-00042 posted/)).toBeInTheDocument();
    seen.length = 0;
    router.query = { invoiceId: 'inv-2' };
    view.rerender(<SupplierInvoiceDetailPage />);
    await screen.findByRole('heading', { name: 'BILL-inv-2' });
    expect(seen.filter((s) => s.billId === 'inv-2' && s.cleared !== null)).toEqual([]);
    expect(screen.queryByText(/Cleared: payment/)).toBeNull();
  });

  it('an in-page cancel of the bill drops the result', async () => {
    fetchMock.mockImplementation(async (url: unknown, init?: unknown) => {
      const u = String(url);
      if ((init as RequestInit | undefined)?.method === 'POST') return ok({});
      if (u.includes('supplier-invoices-detail')) return ok(bill('inv-1'));
      return ok({});
    });
    render(<SupplierInvoiceDetailPage />);
    await screen.findByRole('heading', { name: 'BILL-inv-1' });
    act(() => { latest!.onCleared(result('inv-1')); });
    expect(await screen.findByText(/Cleared: payment SP-00042 posted/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'More invoice actions' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Cancel Invoice/ }));
    const accept = (await screen.findAllByRole('button', { name: 'Cancel Invoice' })).at(-1)!;
    fireEvent.click(accept);
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u).includes('supplier-invoices-action'))).toBe(true));
    await waitFor(() => expect(screen.queryByText(/Cleared: payment/)).toBeNull());
  });
});
