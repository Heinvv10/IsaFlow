/**
 * K-137 (UI half): the PUT route now refuses a save on a bill that is no
 * longer draft/pending_approval (e.g. someone else approved it between page
 * load and Save) with a 4xx and a message. `apiFetch` RESOLVES on 4xx — see
 * src/lib/apiFetch.ts — so `handleSaveEdit` must check `res.ok` itself or the
 * refusal is silently swallowed: the form closes, the edit is discarded, and
 * the screen reports success for a save that never happened.
 *
 * Rendered, not grepped: the message travels through a catch and a state
 * setter, and the form must stay open so the user's edits aren't lost.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('@/lib/apiFetch', () => ({ apiFetch: vi.fn() }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: 'owner' }) }));
vi.mock('next/router', () => ({
  useRouter: () => ({ query: { invoiceId: 'inv-1' } }),
}));
vi.mock('@/components/layout/AppLayout', () => ({
  AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/components/accounting/ap/ThreeWayMatchPanel', () => ({
  ThreeWayMatchPanel: () => null,
}));
vi.mock('@/modules/accounting/documents', () => ({
  AccountingDocumentPanel: () => null,
}));

import { apiFetch } from '@/lib/apiFetch';
import SupplierInvoiceDetailPage from '../../../pages/accounting/supplier-invoices/[invoiceId]';

const fetchMock = apiFetch as unknown as ReturnType<typeof vi.fn>;

const draftInvoice = {
  id: 'inv-1', invoiceNumber: 'INV-001', supplierName: 'Acme Supplies',
  status: 'draft', invoiceDate: '2026-03-01', dueDate: '2026-03-31',
  paymentTerms: '30 days', subtotal: 1000, taxAmount: 150, taxRate: 15,
  totalAmount: 1150, balance: 1150, notes: '', items: [],
};

const ok = (data: unknown) => ({ ok: true, json: () => Promise.resolve({ data }) });

describe('supplier invoice detail page — save refusal', () => {
  beforeEach(() => { fetchMock.mockReset(); });

  it("shows the server's refusal and keeps the form open instead of reporting success", async () => {
    fetchMock.mockResolvedValueOnce(ok(draftInvoice));

    render(<SupplierInvoiceDetailPage />);
    fireEvent.click(await screen.findByText('Edit'));

    fetchMock.mockResolvedValueOnce({
      ok: false,
      json: () => Promise.resolve({
        success: false,
        error: { message: 'Only draft or pending-approval invoices can be edited' },
      }),
    });

    fireEvent.click(await screen.findByText('Save'));

    expect(await screen.findByText(
      'Only draft or pending-approval invoices can be edited',
    )).toBeDefined();
    // The edit form must still be open — a discarded edit must not look saved.
    expect(await screen.findByText('Save')).toBeDefined();
  });

  it('closes the form and refetches when the save succeeds', async () => {
    fetchMock.mockResolvedValueOnce(ok(draftInvoice));

    render(<SupplierInvoiceDetailPage />);
    fireEvent.click(await screen.findByText('Edit'));

    fetchMock.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ data: {} }) });
    fetchMock.mockResolvedValueOnce(ok({ ...draftInvoice, notes: 'saved' }));

    fireEvent.click(await screen.findByText('Save'));

    await waitFor(() => expect(screen.queryByText('Save')).toBeNull());
    expect(screen.getByText('Edit')).toBeDefined();
  });
});
