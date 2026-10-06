/**
 * R-035 PR5 (UI):
 *  - the Enforce switch lists supplier payments and payment batches by name,
 *    with the count of UNPAID ones each would hold, and switches that type;
 *  - active rules of the legacy `payment` type govern neither, so both
 *    switches warn about them (the credit-note warning is unchanged);
 *  - a request for a payment or a batch links to its page from Approvals > Pending.
 */
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ApprovalsPage from '@/../pages/accounting/approvals';
import { apiFetch } from '@/lib/apiFetch';
import { approvalDocumentHref } from '@/components/accounting/approvals/approvalDocumentHref';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
useApiJsonOverMock();
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <>{children}</> }));

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const ENFORCEABLE = ['supplier_invoice', 'customer_credit_note', 'supplier_credit_note', 'customer_invoice', 'supplier_payment', 'payment_batch'];

function answer(legacy: { legacyCreditNoteRules: number; legacyPaymentRules: number }) {
  vi.mocked(apiFetch).mockReset().mockImplementation(async (url, init) => {
    const path = String(url);
    if (path.startsWith('/api/accounting/approval-enforcement') && init?.method === 'POST') return json({ success: true, data: {} });
    if (path.startsWith('/api/accounting/approval-enforcement')) {
      return json({ data: {
        items: [], enforceable: ENFORCEABLE, ...legacy,
        ...(path.includes('preview=1') ? { preview: { supplier_payment: 2, payment_batch: 1 } } : {}),
      } });
    }
    if (path.startsWith('/api/accounting/approval-requests')) {
      return json({ data: { items: [
        { id: '1', ruleName: 'Owner pays', documentType: 'supplier_payment', documentId: 'pay-9', documentReference: 'SP-0009',
          amount: 1150, documentDigest: 'a'.repeat(64), status: 'pending', requestedByName: 'Requester',
          requestedAt: '2026-10-06T08:00:00Z', decidedAt: null, decisionNotes: null },
        { id: '2', ruleName: 'Owner pays', documentType: 'payment_batch', documentId: 'bat-9', documentReference: 'BAT-0009',
          amount: 3450, documentDigest: 'b'.repeat(64), status: 'pending', requestedByName: 'Requester',
          requestedAt: '2026-10-06T08:00:00Z', decidedAt: null, decisionNotes: null },
      ] } });
    }
    return json({ data: { items: [] } });
  });
}

afterEach(() => { cleanup(); });

const openRules = async () => {
  render(<ApprovalsPage />);
  fireEvent.click(await screen.findByRole('button', { name: /rules/i }));
};

describe('the Enforce switch', () => {
  it('lists both payment types with the unpaid documents each would hold, and switches the type', async () => {
    answer({ legacyCreditNoteRules: 0, legacyPaymentRules: 0 });
    await openRules();
    const box = await screen.findByRole('checkbox', { name: /enforce supplier payment approvals/i });
    expect(screen.getByRole('checkbox', { name: /enforce payment batch approvals/i })).toBeDefined();
    expect(screen.getByText(/2 unpaid payments would need approval/i)).toBeDefined();
    expect(screen.getByText(/1 unpaid batch would need approval/i)).toBeDefined();
    fireEvent.click(box);
    await waitFor(() => expect(vi.mocked(apiFetch).mock.calls
      .filter(([u, init]) => String(u).startsWith('/api/accounting/approval-enforcement') && init?.method === 'POST')
      .map(([, init]) => JSON.parse(String(init?.body)))).toEqual([{ documentType: 'supplier_payment', enabled: true }]));
  });

  it('warns beside both payment switches when legacy payment rules are active, and nowhere else', async () => {
    answer({ legacyCreditNoteRules: 0, legacyPaymentRules: 2 });
    await openRules();
    await screen.findByRole('checkbox', { name: /enforce payment batch approvals/i });
    expect(screen.getAllByText('2 legacy payment rules govern nothing — re-create them as supplier payment or payment batch rules'))
      .toHaveLength(2);
  });

  it('keeps the legacy credit-note warning word for word', async () => {
    answer({ legacyCreditNoteRules: 1, legacyPaymentRules: 0 });
    await openRules();
    await screen.findByRole('checkbox', { name: /enforce supplier credit note approvals/i });
    expect(screen.getAllByText('1 legacy credit-note rule governs nothing — re-create it as a customer/supplier credit-note rule'))
      .toHaveLength(2);
    expect(screen.queryByText(/legacy payment rule/)).toBeNull();
  });
});

describe('pending requests', () => {
  it('link a payment and a batch to their pages, under their type labels', async () => {
    answer({ legacyCreditNoteRules: 0, legacyPaymentRules: 0 });
    render(<ApprovalsPage />);
    expect((await screen.findByRole('link', { name: 'SP-0009' })).getAttribute('href')).toBe('/accounting/supplier-payments/pay-9');
    expect(screen.getByRole('link', { name: 'BAT-0009' }).getAttribute('href')).toBe('/accounting/batch-payments/bat-9');
    expect(screen.getByText('Supplier Payment')).toBeDefined();
    expect(screen.getByText('Payment Batch')).toBeDefined();
    expect(approvalDocumentHref('payment', 'x')).toBeNull();
  });
});
