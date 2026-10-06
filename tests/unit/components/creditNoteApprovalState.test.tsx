/**
 * R-035 PR3 (UI): both credit-note detail pages show the DERIVED approval
 * state their detail GET returns, through the generic DocumentApprovalPanel,
 * and offer "Submit for approval" — not Approve / Post — while the note is
 * held (required, pending, stale).
 *
 * Approve / Post can still race into a 409 (a rule added, the note merged) —
 * apiFetch RESOLVES on a 4xx, so the page must read res.ok, show the
 * server's message, and reload into the state that offers Submit.
 */
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
useApiJsonOverMock();
vi.mock('next/router', () => ({ useRouter: () => ({ query: { creditNoteId: 'cn-1', id: 'cn-1' }, push: vi.fn() }) }));
vi.mock('@/components/layout/AppLayout', () => ({
  AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/modules/accounting/documents', () => ({ AccountingDocumentPanel: () => null }));

import { apiFetch } from '@/lib/apiFetch';
import CreditNoteDetailPage from '../../../pages/accounting/credit-notes/[creditNoteId]';
import SupplierCreditNoteDetailPage from '../../../pages/accounting/supplier-credit-notes/[id]';

const fetchMock = apiFetch as unknown as ReturnType<typeof vi.fn>;

type State = 'not_required' | 'required' | 'pending' | 'approved' | 'stale';
const note = (type: 'customer' | 'supplier', state: State) => ({
  id: 'cn-1', creditNoteNumber: 'CN-0001', type, clientName: 'Acme', supplierName: 'Acme Supplies',
  creditDate: '2026-09-01', subtotal: 1000, taxRate: 15, taxAmount: 150, totalAmount: 1150,
  status: 'draft', createdAt: '2026-09-01',
  approval: { state, enforced: state !== 'not_required', requiredRole: 'owner', ruleName: 'Owner signs', requestId: state === 'required' ? null : 'req-1' },
});
const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const refused = (status: number, message: string, reason?: string) =>
  new Response(JSON.stringify({ success: false, error: { code: 'CONFLICT', message, details: reason ? { reason } : undefined } }), { status });
const posts = () => fetchMock.mock.calls
  .filter(([, init]) => ['POST', 'PATCH'].includes(String((init as RequestInit | undefined)?.method)))
  .map(([url, init]) => ({ url: String(url), body: JSON.parse(String((init as RequestInit).body)) }));

const PAGES = [
  { name: 'customer note page', Page: CreditNoteDetailPage, type: 'customer' as const, post: 'Approve & Post GL', docType: 'customer_credit_note' },
  { name: 'supplier note page', Page: SupplierCreditNoteDetailPage, type: 'supplier' as const, post: 'Post', docType: 'supplier_credit_note' },
  // The customer page loads any note by id: a supplier note there is submitted as one.
  { name: 'customer page, supplier note', Page: CreditNoteDetailPage, type: 'supplier' as const, post: 'Approve & Post GL', docType: 'supplier_credit_note' },
];

describe.each(PAGES)('$name — approval state', ({ Page, type, post, docType }) => {
  beforeEach(() => { fetchMock.mockReset(); });
  const postButton = () => screen.queryByRole('button', { name: new RegExp(`^${post}$`) });

  it('required: says who must approve, offers Submit, hides the post button', async () => {
    fetchMock.mockResolvedValueOnce(ok(note(type, 'required')));
    render(<Page />);
    expect(await screen.findByText(/this credit note needs owner approval before it can be posted \(rule: Owner signs\)/i)).toBeDefined();
    expect(screen.getByRole('button', { name: /submit for approval/i })).toBeDefined();
    expect(postButton()).toBeNull();
  });

  it(`Submit raises the request as ${docType} for this note and reloads`, async () => {
    fetchMock.mockResolvedValueOnce(ok(note(type, 'required')));
    render(<Page />);
    fetchMock.mockResolvedValueOnce(ok({ id: 'req-1' }));
    fetchMock.mockResolvedValueOnce(ok(note(type, 'pending')));
    fireEvent.click(await screen.findByRole('button', { name: /submit for approval/i }));
    await waitFor(() => expect(posts()).toEqual([{
      url: '/api/accounting/approval-requests',
      body: { action: 'request', documentType: docType, documentId: 'cn-1' },
    }]));
    expect(await screen.findByText(/awaiting approval by an? owner/i)).toBeDefined();
    expect(postButton()).toBeNull();
  });

  it('pending and stale hide the post button; stale offers Submit again', async () => {
    fetchMock.mockResolvedValueOnce(ok(note(type, 'stale')));
    render(<Page />);
    expect(await screen.findByText(/this credit note changed after it was approved/i)).toBeDefined();
    expect(screen.getByRole('button', { name: /submit for approval/i })).toBeDefined();
    expect(postButton()).toBeNull();
  });

  it('approved (or no rule): the post button is offered', async () => {
    fetchMock.mockResolvedValueOnce(ok(note(type, 'approved')));
    render(<Page />);
    expect(await screen.findByText(/approved by an? owner/i)).toBeDefined();
    expect(postButton()).not.toBeNull();
  });

  it('a post that races into a 409 shows the refusal and, reloaded, offers Submit', async () => {
    fetchMock.mockResolvedValueOnce(ok(note(type, 'approved')));
    render(<Page />);
    const message = `${type === 'customer' ? 'Customer' : 'Supplier'} credit note CN-0001 changed after it was approved; submit it for approval again (rule: Owner signs).`;
    fetchMock.mockResolvedValueOnce(refused(409, message, 'APPROVAL_STALE'));
    fetchMock.mockResolvedValueOnce(ok(note(type, 'stale')));
    await waitFor(() => expect(postButton()).not.toBeNull());
    fireEvent.click(postButton()!);
    expect(await screen.findByText(message)).toBeDefined();
    expect(await screen.findByRole('button', { name: /submit for approval/i })).toBeDefined();
    expect(postButton()).toBeNull();
  });
});
