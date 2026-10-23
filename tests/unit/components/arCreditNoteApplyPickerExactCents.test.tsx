// The credit-note "Apply to Invoice" picker lists an invoice while any cent is owing: the backend (applyCreditNoteToInvoice)
// now applies a note to a one-cent remnant, so a picker that hides it strands that cent.
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
useApiJsonOverMock();
vi.mock('next/router', () => ({ useRouter: () => ({ query: { creditNoteId: 'cn-1', id: 'cn-1' }, push: vi.fn() }) }));
vi.mock('@/components/layout/AppLayout', () => ({
  AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/modules/accounting/documents', () => ({ AccountingDocumentPanel: () => null }));

import { apiFetch } from '@/lib/apiFetch';
import CreditNoteDetailPage from '../../../pages/accounting/credit-notes/[creditNoteId]';

const fetchMock = apiFetch as unknown as ReturnType<typeof vi.fn>;
const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });

const NOTE = {
  id: 'cn-1', creditNoteNumber: 'CN-0001', type: 'customer', clientId: 'c-1', clientName: 'Acme',
  creditDate: '2026-09-01', subtotal: 100, taxRate: 0, taxAmount: 0, totalAmount: 100, status: 'approved',
  createdAt: '2026-09-01', approval: { state: 'not_required', enforced: false },
};
const INVOICES = [
  { id: 'i-cent', invoice_number: 'INV-CENT', invoice_date: '2026-08-01', total_amount: 200, amount_paid: 199.99 },
  { id: 'i-none', invoice_number: 'INV-NONE', invoice_date: '2026-08-01', total_amount: 200, amount_paid: 200 },
];

describe('credit-note apply picker, whole cents', () => {
  beforeEach(() => {
    fetchMock.mockReset().mockImplementation(async (url: unknown) =>
      String(url).includes('customer-invoices-list') ? ok(INVOICES) : ok(NOTE));
  });

  it('offers an invoice owing one cent, and not one owing nothing', async () => {
    render(<CreditNoteDetailPage />);
    fireEvent.click(await screen.findByRole('button', { name: /apply to invoice/i }));

    expect(await screen.findByText('INV-CENT')).toBeDefined();
    expect(screen.queryByText('INV-NONE')).toBeNull();
  });
});
