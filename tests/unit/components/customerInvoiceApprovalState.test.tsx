/**
 * R-035 PR4 (UI): the customer-invoice detail page shows the DERIVED approval
 * state its detail GET returns, through DocumentApprovalPanel, and offers
 * "Submit for approval" — not Approve — while the invoice is held (required,
 * pending, stale).
 *
 * Approve can still race into a 409 (a rule added, the invoice edited or
 * merged) — apiFetch RESOLVES on a 4xx, so the page must read res.ok, show the
 * server's message, and reload into the state that offers Submit.
 */
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
useApiJsonOverMock();
vi.mock('next/router', () => ({ useRouter: () => ({ query: { invoiceId: 'inv-1' }, push: vi.fn() }) }));
vi.mock('@/components/layout/AppLayout', () => ({
  AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/modules/accounting/documents', () => ({ AccountingDocumentPanel: () => null }));
vi.mock('@/components/accounting/sars/MarkVatDeclaredElsewhereButton', () => ({ MarkVatDeclaredElsewhereButton: () => null }));

import { apiFetch } from '@/lib/apiFetch';
import CustomerInvoiceDetailPage from '../../../pages/accounting/customer-invoices/[invoiceId]';

const fetchMock = apiFetch as unknown as ReturnType<typeof vi.fn>;

type State = 'not_required' | 'required' | 'pending' | 'approved' | 'stale';
const invoice = (state: State) => ({
  id: 'inv-1', invoice_number: 'INV-0001', client_name: 'Acme', project_name: '', status: 'draft',
  invoice_date: '2026-09-01', due_date: '2026-10-01', subtotal: 1000, tax_rate: 15, tax_amount: 150,
  total_amount: 1150, amount_paid: 0, notes: '', gl_journal_entry_id: null, items: [],
  approval: { state, enforced: state !== 'not_required', requiredRole: 'owner', ruleName: 'Owner signs', requestId: state === 'required' ? null : 'req-1' },
});
const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const refused = (status: number, message: string, reason?: string) =>
  new Response(JSON.stringify({ success: false, error: { code: 'CONFLICT', message, details: reason ? { reason } : undefined } }), { status });
const posts = () => fetchMock.mock.calls
  .filter(([, init]) => String((init as RequestInit | undefined)?.method) === 'POST')
  .map(([url, init]) => ({ url: String(url), body: JSON.parse(String((init as RequestInit).body)) }));

/** Detail GETs answer from `states` in turn (the last repeats); POSTs from `postAnswers`; the rest are empty. */
function serve(states: State[], postAnswers: Response[] = []) {
  let gets = 0;
  fetchMock.mockReset().mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return postAnswers.shift() ?? ok({});
    if (String(url).startsWith('/api/accounting/customer-invoices-detail')) {
      return ok(invoice(states[Math.min(gets++, states.length - 1)]!));
    }
    return ok({ prevId: null, nextId: null });
  });
}

const approveButton = () => screen.queryByRole('button', { name: /^Approve$/ });

describe('customer invoice page — approval state', () => {
  beforeEach(() => { fetchMock.mockReset(); });

  it('required: says who must approve, offers Submit, hides Approve', async () => {
    serve(['required']);
    render(<CustomerInvoiceDetailPage />);
    expect(await screen.findByText(/this invoice needs owner approval before it can be posted \(rule: Owner signs\)/i)).toBeDefined();
    expect(screen.getByRole('button', { name: /submit for approval/i })).toBeDefined();
    expect(approveButton()).toBeNull();
  });

  it('Submit raises the request as customer_invoice for this invoice and reloads', async () => {
    serve(['required', 'pending'], [ok({ id: 'req-1' })]);
    render(<CustomerInvoiceDetailPage />);
    fireEvent.click(await screen.findByRole('button', { name: /submit for approval/i }));
    await waitFor(() => expect(posts()).toEqual([{
      url: '/api/accounting/approval-requests',
      body: { action: 'request', documentType: 'customer_invoice', documentId: 'inv-1' },
    }]));
    expect(await screen.findByText(/awaiting approval by an? owner/i)).toBeDefined();
    expect(approveButton()).toBeNull();
  });

  it('stale offers Submit again and hides Approve', async () => {
    serve(['stale']);
    render(<CustomerInvoiceDetailPage />);
    expect(await screen.findByText(/this invoice changed after it was approved/i)).toBeDefined();
    expect(screen.getByRole('button', { name: /submit for approval/i })).toBeDefined();
    expect(approveButton()).toBeNull();
  });

  it('approved: Approve is offered', async () => {
    serve(['approved']);
    render(<CustomerInvoiceDetailPage />);
    expect(await screen.findByText(/approved by an? owner/i)).toBeDefined();
    expect(approveButton()).not.toBeNull();
  });

  it('an Approve that races into a 409 shows the refusal and, reloaded, offers Submit', async () => {
    const message = 'Customer invoice INV-0001 changed after it was approved; submit it for approval again (rule: Owner signs).';
    serve(['approved', 'stale'], [refused(409, message, 'APPROVAL_STALE')]);
    render(<CustomerInvoiceDetailPage />);
    await waitFor(() => expect(approveButton()).not.toBeNull());
    fireEvent.click(approveButton()!);
    expect(await screen.findByText(message)).toBeDefined();
    expect(await screen.findByRole('button', { name: /submit for approval/i })).toBeDefined();
    expect(approveButton()).toBeNull();
  });
});
