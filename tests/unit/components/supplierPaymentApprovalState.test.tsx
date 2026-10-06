/**
 * R-035 PR5 (UI): the supplier-payment and payment-batch pages show the
 * DERIVED approval state their detail GETs return, through
 * DocumentApprovalPanel in its 'pay' wording, and hide Approve / Process while
 * the document is held (required, pending, stale) — the panel offers Submit.
 *
 * Approve or Process can still race into a 409 (a rule added, a payee's bank
 * details changed) — apiFetch RESOLVES on a 4xx, so the page reads res.ok,
 * shows the refusal BESIDE the document (not in place of it), and reloads into
 * the state that offers Submit.
 */
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
useApiJsonOverMock();
vi.mock('next/router', () => ({ useRouter: () => ({ query: { paymentId: 'pay-1', batchId: 'bat-1' }, push: vi.fn() }) }));
vi.mock('@/components/layout/AppLayout', () => ({
  AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/modules/accounting/documents', () => ({ AccountingDocumentPanel: () => null }));

import { apiFetch } from '@/lib/apiFetch';
import SupplierPaymentDetailPage from '../../../pages/accounting/supplier-payments/[paymentId]';
import BatchPaymentDetailPage from '../../../pages/accounting/batch-payments/[batchId]';

const fetchMock = apiFetch as unknown as ReturnType<typeof vi.fn>;

type State = 'not_required' | 'required' | 'pending' | 'approved' | 'stale';
const approval = (state: State) => ({
  state, enforced: state !== 'not_required', requiredRole: 'owner', ruleName: 'Owner pays', requestId: state === 'required' ? null : 'req-1',
});
const payment = (state: State, status = 'draft') => ({
  id: 'pay-1', paymentNumber: 'SP-0001', supplierName: 'Acme', paymentDate: '2026-09-01', totalAmount: 1150,
  paymentMethod: 'eft', status, allocations: [], approval: approval(state),
});
const batch = (state: State, status = 'draft') => ({
  id: 'bat-1', batchNumber: 'BAT-0001', batchDate: '2026-09-01', totalAmount: 3450, paymentCount: 1, paymentMethod: 'eft',
  status, billCount: 1, approval: approval(state),
  payments: [{ id: 'pay-2', paymentNumber: 'SP-0002', supplierName: 'Acme', amount: 3450, status, payeeBank: 'R035 Bank 62000000001' }],
});
const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const refused = (message: string, reason: string) =>
  new Response(JSON.stringify({ success: false, error: { code: 'CONFLICT', message, details: { reason } } }), { status: 409 });
const posts = () => fetchMock.mock.calls
  .filter(([, init]) => String((init as RequestInit | undefined)?.method) === 'POST')
  .map(([url, init]) => ({ url: String(url), body: JSON.parse(String((init as RequestInit).body)) }));

/** Detail GETs answer from `docs` in turn (the last repeats); POSTs from `postAnswers`. */
function serve(docs: unknown[], postAnswers: Response[] = []) {
  let gets = 0;
  fetchMock.mockReset().mockImplementation(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return postAnswers.shift() ?? ok({});
    return ok(docs[Math.min(gets++, docs.length - 1)]);
  });
}

const button = (name: RegExp) => screen.queryByRole('button', { name });

describe('supplier payment page — approval state', () => {
  beforeEach(() => { fetchMock.mockReset(); });

  it('required: says who must approve before it can be PAID, offers Submit, hides Approve', async () => {
    serve([payment('required')]);
    render(<SupplierPaymentDetailPage />);
    expect(await screen.findByText('This payment needs owner approval before it can be paid (rule: Owner pays).')).toBeDefined();
    expect(button(/submit for approval/i)).not.toBeNull();
    expect(button(/^Approve$/)).toBeNull();
  });

  it('Submit raises the request as supplier_payment for this payment', async () => {
    serve([payment('required'), payment('pending')], [ok({ id: 'req-1' })]);
    render(<SupplierPaymentDetailPage />);
    fireEvent.click(await screen.findByRole('button', { name: /submit for approval/i }));
    await waitFor(() => expect(posts()).toEqual([{
      url: '/api/accounting/approval-requests', body: { action: 'request', documentType: 'supplier_payment', documentId: 'pay-1' },
    }]));
    expect(await screen.findByText(/awaiting approval by an? owner/i)).toBeDefined();
  });

  it('an approved, approved-status payment offers Process; a stale one hides it', async () => {
    serve([payment('approved', 'approved')]);
    const { unmount } = render(<SupplierPaymentDetailPage />);
    expect(await screen.findByText('Approved by an owner — ready to pay.')).toBeDefined();
    expect(button(/process/i)).not.toBeNull();
    unmount();
    serve([payment('stale', 'approved')]);
    render(<SupplierPaymentDetailPage />);
    expect(await screen.findByText(/this payment changed after it was approved\. submit it for approval again before paying\./i)).toBeDefined();
    expect(button(/process/i)).toBeNull();
  });

  it('a Process that races into a 409 shows the refusal beside the payment and, reloaded, offers Submit', async () => {
    const message = 'Supplier payment SP-0001 changed after it was approved; submit it for approval again (rule: Owner pays).';
    serve([payment('approved', 'approved'), payment('stale', 'approved')], [refused(message, 'APPROVAL_STALE')]);
    render(<SupplierPaymentDetailPage />);
    await waitFor(() => expect(button(/process/i)).not.toBeNull());
    fireEvent.click(button(/process/i)!);
    expect(await screen.findByText(message)).toBeDefined();
    expect(await screen.findByRole('button', { name: /submit for approval/i })).toBeDefined();
    expect(screen.getByText('SP-0001')).toBeDefined();
    expect(button(/process/i)).toBeNull();
  });
});

describe('payment batch page — approval state', () => {
  beforeEach(() => { fetchMock.mockReset(); });

  it('required: the panel names the batch, Approve is hidden, and each line shows where its money goes', async () => {
    serve([batch('required')]);
    render(<BatchPaymentDetailPage />);
    expect(await screen.findByText('This batch needs owner approval before it can be paid (rule: Owner pays).')).toBeDefined();
    expect(button(/^Approve$/)).toBeNull();
    expect(screen.getByText('R035 Bank 62000000001')).toBeDefined();
  });

  it('Submit raises one request for the whole batch', async () => {
    serve([batch('required'), batch('pending')], [ok({ id: 'req-1' })]);
    render(<BatchPaymentDetailPage />);
    fireEvent.click(await screen.findByRole('button', { name: /submit for approval/i }));
    await waitFor(() => expect(posts()).toEqual([{
      url: '/api/accounting/approval-requests', body: { action: 'request', documentType: 'payment_batch', documentId: 'bat-1' },
    }]));
  });

  it('an Approve that races into a 409 shows the refusal and, reloaded, offers Submit', async () => {
    const message = 'Payment batch BAT-0001 needs owner approval before it can be paid (rule: Owner pays).';
    serve([batch('approved'), batch('required')], [refused(message, 'APPROVAL_REQUIRED')]);
    render(<BatchPaymentDetailPage />);
    await waitFor(() => expect(button(/^Approve$/)).not.toBeNull());
    fireEvent.click(button(/^Approve$/)!);
    expect(await screen.findByText(message)).toBeDefined();
    expect(await screen.findByRole('button', { name: /submit for approval/i })).toBeDefined();
    expect(button(/^Approve$/)).toBeNull();
  });
});
