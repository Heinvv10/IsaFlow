/**
 * R-035 PR2 (UI): the supplier-invoice detail page shows the DERIVED approval
 * state the detail GET returns, and offers "Submit for approval" where the bill
 * cannot post yet (required, stale) instead of "Approve & Post GL".
 *
 * Approve can still race into a 409 (a rule added, the content edited) —
 * apiFetch RESOLVES on a 4xx, so the page must read res.ok, show the refusal,
 * and reload into the state that offers Submit.
 */
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
useApiJsonOverMock();
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: 'owner' }) }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: { invoiceId: 'inv-1' }, push: vi.fn() }) }));
vi.mock('@/components/layout/AppLayout', () => ({
  AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/components/accounting/ap/ThreeWayMatchPanel', () => ({ ThreeWayMatchPanel: () => null }));
vi.mock('@/modules/accounting/documents', () => ({ AccountingDocumentPanel: () => null }));

import { apiFetch } from '@/lib/apiFetch';
import SupplierInvoiceDetailPage from '../../../pages/accounting/supplier-invoices/[invoiceId]';

const fetchMock = apiFetch as unknown as ReturnType<typeof vi.fn>;

type State = 'not_required' | 'required' | 'pending' | 'approved' | 'stale';
const invoice = (state: State) => ({
  id: 'inv-1', invoiceNumber: 'INV-001', supplierName: 'Acme Supplies',
  status: 'draft', invoiceDate: '2026-03-01', dueDate: '2026-03-31',
  paymentTerms: '30 days', subtotal: 1000, taxAmount: 150, taxRate: 15,
  totalAmount: 1150, balance: 1150, notes: '', items: [],
  approval: { state, enforced: state !== 'not_required', requiredRole: 'owner', ruleName: 'Owner signs', requestId: state === 'required' ? null : 'req-1' },
});
const ok = (data: unknown) => ({ ok: true, status: 200, json: () => Promise.resolve({ data }) });
const refused = (status: number, message: string, reason?: string) => ({
  ok: false, status, json: () => Promise.resolve({ success: false, error: { message, details: reason ? { reason } : undefined } }),
});
const posts = () => fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST')
  .map(([url, init]) => ({ url: String(url), body: JSON.parse(String((init as RequestInit).body)) }));

describe('supplier invoice detail — approval state', () => {
  beforeEach(() => { fetchMock.mockReset(); });

  it('required: says who must approve, offers Submit, not Approve & Post', async () => {
    fetchMock.mockResolvedValueOnce(ok(invoice('required')));
    render(<SupplierInvoiceDetailPage />);
    expect(await screen.findByText(/needs owner approval/i)).toBeDefined();
    expect(screen.getByRole('button', { name: /submit for approval/i })).toBeDefined();
    expect(screen.queryByText('Approve & Post GL')).toBeNull();
  });

  it('Submit raises the request for this bill and reloads', async () => {
    fetchMock.mockResolvedValueOnce(ok(invoice('required')));
    render(<SupplierInvoiceDetailPage />);
    fetchMock.mockResolvedValueOnce(ok({ id: 'req-1' }));
    fetchMock.mockResolvedValueOnce(ok(invoice('pending')));
    fireEvent.click(await screen.findByRole('button', { name: /submit for approval/i }));
    await waitFor(() => expect(posts()).toEqual([{
      url: '/api/accounting/approval-requests',
      body: { action: 'request', documentType: 'supplier_invoice', documentId: 'inv-1' },
    }]));
    expect(await screen.findByText(/awaiting approval by an? owner/i)).toBeDefined();
  });

  it('a refused Submit shows the reason (apiFetch resolves on 4xx)', async () => {
    fetchMock.mockResolvedValueOnce(ok(invoice('required')));
    render(<SupplierInvoiceDetailPage />);
    fetchMock.mockResolvedValueOnce(refused(403, 'This action cannot be taken while impersonating another user.'));
    fireEvent.click(await screen.findByRole('button', { name: /submit for approval/i }));
    expect(await screen.findByText(/impersonating/)).toBeDefined();
  });

  it('pending: a badge naming the role, and neither Submit nor Approve & Post', async () => {
    fetchMock.mockResolvedValueOnce(ok(invoice('pending')));
    render(<SupplierInvoiceDetailPage />);
    expect(await screen.findByText(/awaiting approval by an? owner/i)).toBeDefined();
    expect(screen.queryByRole('button', { name: /submit for approval/i })).toBeNull();
    expect(screen.queryByText('Approve & Post GL')).toBeNull();
  });

  it('stale: says the bill changed since approval and offers Submit again', async () => {
    fetchMock.mockResolvedValueOnce(ok(invoice('stale')));
    render(<SupplierInvoiceDetailPage />);
    expect(await screen.findByText(/changed after it was approved/i)).toBeDefined();
    expect(screen.getByRole('button', { name: /submit for approval/i })).toBeDefined();
    expect(screen.queryByText('Approve & Post GL')).toBeNull();
  });

  it('approved: Approve & Post is offered', async () => {
    fetchMock.mockResolvedValueOnce(ok(invoice('approved')));
    render(<SupplierInvoiceDetailPage />);
    expect(await screen.findByText('Approve & Post GL')).toBeDefined();
    expect(screen.getByText(/approved by an? owner/i)).toBeDefined();
  });

  it('an approve that races into a 409 shows the refusal and, reloaded, offers Submit', async () => {
    fetchMock.mockResolvedValueOnce(ok(invoice('approved')));
    render(<SupplierInvoiceDetailPage />);
    fetchMock.mockResolvedValueOnce(refused(409,
      'Supplier invoice INV-001 changed after it was approved; submit it for approval again (rule: Owner signs).', 'APPROVAL_STALE'));
    fetchMock.mockResolvedValueOnce(ok(invoice('stale')));
    fireEvent.click(await screen.findByText('Approve & Post GL'));
    expect(await screen.findByText(/submit it for approval again \(rule: Owner signs\)/)).toBeDefined();
    expect(await screen.findByRole('button', { name: /submit for approval/i })).toBeDefined();
  });
});
