/**
 * P4-E, fix round 2 (blind MED-1), through the REAL bill page and the REAL loan clearing panel: after a clearing posts, the page reloads the
 * bill behind its full-page spinner (which unmounts the panel); the confirmation "Cleared: payment SP-... posted" and its journal link must
 * still be there once the page is back. Only the other panels of the page are stubbed.
 */
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
useApiJsonOverMock();
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: 'owner' }) }));
vi.mock('@/utils/toast', () => ({ notify: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: { invoiceId: 'inv-1' } }) }));
vi.mock('@/components/layout/AppLayout', () => ({
  AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/components/accounting/ap/ThreeWayMatchPanel', () => ({ ThreeWayMatchPanel: () => null }));
vi.mock('@/modules/accounting/documents', () => ({ AccountingDocumentPanel: () => null }));
vi.mock('@/components/accounting/comments/CommentsPanel', () => ({ CommentsPanel: () => null }));

import { apiFetch } from '@/lib/apiFetch';
import SupplierInvoiceDetailPage from '../../../pages/accounting/supplier-invoices/[invoiceId]';

const fetchMock = apiFetch as unknown as ReturnType<typeof vi.fn>;
const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const bill = (balance: number) => ({
  id: 'inv-1', invoiceNumber: 'BILL-77', supplierName: 'Velocity Fibre', status: balance > 0 ? 'approved' : 'paid',
  invoiceDate: '2026-09-01', dueDate: '2026-10-01', paymentTerms: '30 days', subtotal: 1000, taxAmount: 150, taxRate: 15,
  totalAmount: 1150, amountPaid: 1150 - balance, balance, notes: '', items: [],
});
const preview = (open: number) => ({
  linked: true, billId: 'inv-1', billNumber: 'BILL-77', billDate: '2026-09-01', linkId: 'link-1', partnerName: 'Velocity Fibre',
  loanAccountId: 'loan-1', loanAccountLabel: '2800 Loan from Velocity', payableAccountId: 'ap-1', payableLabel: '2000 Accounts Payable',
  openAmount: open, maxAmount: open, floorDate: '2026-09-01', defaultPostingDate: '2026-09-10', receiverReady: true,
  blocked: open > 0 ? null : 'This bill is already paid: there is nothing open to clear. Nothing was posted.',
});

describe('supplier bill page: a loan clearing', () => {
  let cleared = false;
  let detailLoads = 0;
  beforeEach(() => {
    cleared = false;
    detailLoads = 0;
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url: unknown, init?: unknown) => {
      const u = String(url);
      if ((init as RequestInit | undefined)?.method === 'POST' && u.includes('/loan-clearings')) {
        cleared = true;
        return ok({ cleared: true, billId: 'inv-1', paymentId: 'pay-1', paymentNumber: 'SP-00042', journalEntryId: 'je-9', messageId: 'm-1' });
      }
      if (u.includes('supplier-invoices-detail')) {
        detailLoads += 1;
        // a real network takes time: the reload's spinner renders (and unmounts the panel) before the bill comes back
        if (cleared) await new Promise((r) => { setTimeout(r, 50); });
        return ok(bill(cleared ? 0 : 1150));
      }
      if (u.includes('/loan-clearings?')) return ok(preview(cleared ? 0 : 1150));
      return ok([]);
    });
  });

  it('the confirmation and its journal link survive the reload of the bill', async () => {
    render(<SupplierInvoiceDetailPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Clear against the intercompany loan' }));
    const dialog = await screen.findByRole('dialog', { name: 'Clear against the intercompany loan' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Review clearing' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Post clearing' }));
    // the page reloads the bill (a second detail load) behind its spinner: the panel is gone, then mounted again
    await waitFor(() => expect(detailLoads).toBe(2));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Intercompany loan' })).toBeNull());
    expect(await screen.findByText(/Cleared: payment SP-00042 posted/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /journal/i })).toHaveAttribute('href', '/accounting/journal-entries/je-9');
  });
});
