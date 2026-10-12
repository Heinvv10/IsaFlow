/**
 * Approving a bill dated in a filed VAT period claims its input VAT late
 * (s16(3)); the approve route says so in `lateClaim`, and the bill page must
 * tell the person — rendered, through the real page and its action bar.
 */
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

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

import { apiFetch } from '@/lib/apiFetch';
import { notify } from '@/utils/toast';
import SupplierInvoiceDetailPage from '../../../pages/accounting/supplier-invoices/[invoiceId]';

const fetchMock = apiFetch as unknown as ReturnType<typeof vi.fn>;
const draft = {
  id: 'inv-1', invoiceNumber: 'INV-001', supplierName: 'Acme Supplies', status: 'draft',
  invoiceDate: '2026-06-12', dueDate: '2026-07-12', paymentTerms: '30 days', subtotal: 1000, taxAmount: 150,
  taxRate: 15, totalAmount: 1150, balance: 1150, notes: '', items: [],
};
const ok = (data: unknown) => ({ ok: true, json: () => Promise.resolve({ success: true, data }) });

describe('supplier invoice page — late claim notice', () => {
  beforeEach(() => { fetchMock.mockReset(); vi.mocked(notify.info).mockReset(); });

  it('tells the person the VAT was claimed in a later period', async () => {
    fetchMock.mockResolvedValueOnce(ok(draft));
    render(<SupplierInvoiceDetailPage />);
    fetchMock.mockResolvedValueOnce(ok({
      ...draft, status: 'approved',
      lateClaim: { claimDate: '2026-07-01', lockPeriod: { start: '2026-05-01', end: '2026-06-30' }, inputTax: 150 },
    }));
    fetchMock.mockResolvedValueOnce(ok({ ...draft, status: 'approved' }));
    fireEvent.click(await screen.findByText('Approve & Post GL'));
    await waitFor(() => expect(notify.info).toHaveBeenCalledWith(
      'Input VAT of R150.00 claimed late, from 2026-07-01', 'Period 2026-05-01 to 2026-06-30 is filed.'));
  });

  it('says nothing for an ordinary approval', async () => {
    fetchMock.mockResolvedValueOnce(ok(draft));
    render(<SupplierInvoiceDetailPage />);
    fetchMock.mockResolvedValueOnce(ok({ ...draft, status: 'approved' }));
    fetchMock.mockResolvedValueOnce(ok({ ...draft, status: 'approved' }));
    fireEvent.click(await screen.findByText('Approve & Post GL'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(notify.info).not.toHaveBeenCalled();
  });
});
