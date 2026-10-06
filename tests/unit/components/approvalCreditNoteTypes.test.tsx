/**
 * R-035 PR3 (UI) on the approvals page:
 *  - the Enforce switch lists both credit-note types by name, with the count
 *    of unposted notes each would hold, and switches each one by its own type;
 *  - a request row names its document type and links to the document
 *    (approvalDocumentHref) — a credit note to its own page, by type — and a
 *    type with no page gets no link.
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
const request = (id: string, documentType: string, documentReference: string) => ({
  id, ruleName: 'Owner signs', documentType, documentId: `doc-${id}`, documentReference, amount: 1150,
  documentDigest: 'a'.repeat(64), status: 'pending', requestedByName: 'Requester',
  requestedAt: '2026-10-06T08:00:00Z', decidedAt: null, decisionNotes: null,
});

function answer(legacyCreditNoteRules = 0) {
  vi.mocked(apiFetch).mockReset().mockImplementation(async (url, init) => {
    const path = String(url);
    if (path.startsWith('/api/accounting/approval-enforcement') && init?.method === 'POST') return json({ success: true, data: {} });
    if (path.startsWith('/api/accounting/approval-enforcement')) {
      return json({ data: {
        items: [],
        enforceable: ['supplier_invoice', 'customer_credit_note', 'supplier_credit_note'],
        legacyCreditNoteRules,
        ...(path.includes('preview=1') ? { preview: { supplier_invoice: 0, customer_credit_note: 2, supplier_credit_note: 1 } } : {}),
      } });
    }
    if (path.startsWith('/api/accounting/approval-requests')) {
      return json({ data: { items: [
        request('1', 'customer_credit_note', 'CN-0001'),
        request('2', 'supplier_credit_note', 'CN-0002'),
        request('3', 'supplier_invoice', 'INV-0003'),
        request('4', 'journal_entry', 'JE-0004'),
      ] } });
    }
    return json({ data: { items: [] } });
  });
}

afterEach(() => { cleanup(); });

describe('the Enforce switch', () => {
  it('lists both credit-note types, each with what it would hold, and switches each by its own type', async () => {
    answer();
    render(<ApprovalsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /rules/i }));
    const customer = await screen.findByRole('checkbox', { name: /enforce customer credit note approvals/i });
    expect(screen.getByRole('checkbox', { name: /enforce supplier credit note approvals/i })).toBeDefined();
    expect(screen.getByText(/2 unposted customer credit notes would need approval/i)).toBeDefined();
    expect(screen.getByText(/1 unposted supplier credit note would need approval/i)).toBeDefined();
    fireEvent.click(customer);
    await waitFor(() => expect(vi.mocked(apiFetch).mock.calls
      .filter(([u, init]) => String(u).startsWith('/api/accounting/approval-enforcement') && init?.method === 'POST')
      .map(([, init]) => JSON.parse(String(init?.body)))).toEqual([{ documentType: 'customer_credit_note', enabled: true }]));
  });
});

describe('legacy credit_note rules (review B2)', () => {
  it('warn beside BOTH credit-note switches, and only those, that they govern nothing', async () => {
    answer(2);
    render(<ApprovalsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /rules/i }));
    await screen.findByRole('checkbox', { name: /enforce customer credit note approvals/i });
    const warnings = screen.getAllByText(
      /2 legacy credit-note rules govern nothing — re-create them as customer\/supplier credit-note rules/i);
    expect(warnings).toHaveLength(2);
  });

  it('say it in the singular for one rule, and say nothing when there are none', async () => {
    answer(1);
    render(<ApprovalsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /rules/i }));
    expect(await screen.findAllByText(/1 legacy credit-note rule governs nothing — re-create it as/i)).toHaveLength(2);
    cleanup();
    answer(0);
    render(<ApprovalsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /rules/i }));
    await screen.findByRole('checkbox', { name: /enforce customer credit note approvals/i });
    expect(screen.queryByText(/legacy credit-note rule/i)).toBeNull();
  });
});

describe('pending requests', () => {
  it('name the credit-note type and link each document to its own page', async () => {
    answer();
    render(<ApprovalsPage />);
    expect((await screen.findByRole('link', { name: 'CN-0001' })).getAttribute('href')).toBe('/accounting/credit-notes/doc-1');
    expect(screen.getByRole('link', { name: 'CN-0002' }).getAttribute('href')).toBe('/accounting/supplier-credit-notes/doc-2');
    expect(screen.getByRole('link', { name: 'INV-0003' }).getAttribute('href')).toBe('/accounting/supplier-invoices/doc-3');
    expect(screen.getByText('Customer Credit Note')).toBeDefined();
    expect(screen.getByText('Supplier Credit Note')).toBeDefined();
    // A type with no page in this map is shown, not linked.
    expect(screen.getByText('JE-0004')).toBeDefined();
    expect(screen.queryByRole('link', { name: 'JE-0004' })).toBeNull();
  });

  it('approvalDocumentHref maps only the types it knows', () => {
    expect(approvalDocumentHref('customer_credit_note', 'x')).toBe('/accounting/credit-notes/x');
    expect(approvalDocumentHref('supplier_credit_note', 'x')).toBe('/accounting/supplier-credit-notes/x');
    expect(approvalDocumentHref('supplier_invoice', 'x')).toBe('/accounting/supplier-invoices/x');
    expect(approvalDocumentHref('credit_note', 'x')).toBeNull();
    expect(approvalDocumentHref('payment', 'x')).toBeNull();
  });
});
