/**
 * R-035 PR4 (UI):
 *  - the Enforce switch lists customer invoices by name, with the count of
 *    unposted invoices it would hold, and switches the customer_invoice type;
 *  - an approval request for a customer invoice links to the invoice's page
 *    (approvalDocumentHref) from Approvals > Pending;
 *  - a recurring run that held invoices for approval says how many.
 */
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ApprovalsPage from '@/../pages/accounting/approvals';
import RecurringInvoicesPage from '@/../pages/accounting/recurring-invoices';
import { apiFetch } from '@/lib/apiFetch';
import { approvalDocumentHref } from '@/components/accounting/approvals/approvalDocumentHref';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
useApiJsonOverMock();
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <>{children}</> }));

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function answerApprovals() {
  vi.mocked(apiFetch).mockReset().mockImplementation(async (url, init) => {
    const path = String(url);
    if (path.startsWith('/api/accounting/approval-enforcement') && init?.method === 'POST') return json({ success: true, data: {} });
    if (path.startsWith('/api/accounting/approval-enforcement')) {
      return json({ data: {
        items: [], legacyCreditNoteRules: 0,
        enforceable: ['supplier_invoice', 'customer_credit_note', 'supplier_credit_note', 'customer_invoice'],
        ...(path.includes('preview=1')
          ? { preview: { supplier_invoice: 0, customer_credit_note: 0, supplier_credit_note: 0, customer_invoice: 3 } } : {}),
      } });
    }
    if (path.startsWith('/api/accounting/approval-requests')) {
      return json({ data: { items: [{
        id: '1', ruleName: 'Owner signs', documentType: 'customer_invoice', documentId: 'inv-9', documentReference: 'INV-0009',
        amount: 1150, documentDigest: 'a'.repeat(64), status: 'pending', requestedByName: 'Requester',
        requestedAt: '2026-10-06T08:00:00Z', decidedAt: null, decisionNotes: null,
      }] } });
    }
    return json({ data: { items: [] } });
  });
}

afterEach(() => { cleanup(); });

/**
 * "Run Due" is disabled until the templates have loaded and one is due, and the count in its label ("Run Due (1)")
 * appears at that moment. A click on it earlier is a silent no-op (the original findByRole could resolve while it was
 * still disabled, then the result text never came), so wait for the count, then check it is enabled.
 */
const runDueButton = async () => {
  const label = await turns(() => screen.getByText(/run due \(1\)/i));
  const button = label.closest('button')!;
  expect(button.disabled).toBe(false);
  return button;
};

/**
 * Wait for `read` to stop throwing by yielding whole event-loop turns, counted, not timed: a findBy* has a 1 s
 * budget, and a role query over this page can take longer than that on a starved box. Each turn lets the mocked
 * fetch -> json() -> setState chain advance, so the chain's order, not the machine's speed, decides the outcome.
 */
async function turns<T>(read: () => T): Promise<T> {
  let last: unknown;
  for (let i = 0; i < 500; i += 1) {
    try { return read(); } catch (err) { last = err; }
    await act(async () => { await new Promise<void>((r) => setImmediate(r)); });
  }
  throw last;
}

describe('the Enforce switch', () => {
  it('lists customer invoices with what the switch would hold, and switches that type', async () => {
    answerApprovals();
    render(<ApprovalsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /rules/i }));
    const box = await screen.findByRole('checkbox', { name: /enforce customer invoice approvals/i });
    expect(screen.getByText(/3 unposted invoices would need approval/i)).toBeDefined();
    fireEvent.click(box);
    await waitFor(() => expect(vi.mocked(apiFetch).mock.calls
      .filter(([u, init]) => String(u).startsWith('/api/accounting/approval-enforcement') && init?.method === 'POST')
      .map(([, init]) => JSON.parse(String(init?.body)))).toEqual([{ documentType: 'customer_invoice', enabled: true }]));
  });
});

describe('pending requests', () => {
  it('link a customer invoice to its page, under its type label', async () => {
    answerApprovals();
    render(<ApprovalsPage />);
    expect((await screen.findByRole('link', { name: 'INV-0009' })).getAttribute('href')).toBe('/accounting/customer-invoices/inv-9');
    expect(screen.getByText('Customer Invoice')).toBeDefined();
    expect(approvalDocumentHref('customer_invoice', 'x')).toBe('/accounting/customer-invoices/x');
  });
});

describe('the recurring invoices run', () => {
  it('says how many generated invoices were held for approval', async () => {
    vi.mocked(apiFetch).mockReset().mockImplementation(async (url, init) => {
      if (String(url).startsWith('/api/accounting/recurring-invoices-run') && init?.method === 'POST') {
        return json({ success: true, data: { generated: 3, invoice_ids: ['a', 'b', 'c'], held_for_approval: ['a', 'c'], errors: [] } });
      }
      return json({ data: { items: [{ id: 't1', templateName: 'Retainer', clientId: 'c', frequency: 'monthly',
        nextRunDate: '2026-01-01', runCount: 0, status: 'active', totalAmount: 1150 }] } });
    });
    render(<RecurringInvoicesPage />);
    fireEvent.click(await runDueButton());
    await turns(() => screen.getByText(/3 invoices generated — 2 held for approval/i));
  });

  it('says nothing about approval when none was held, or the server sent no list', async () => {
    vi.mocked(apiFetch).mockReset().mockImplementation(async (url, init) => {
      if (String(url).startsWith('/api/accounting/recurring-invoices-run') && init?.method === 'POST') {
        return json({ success: true, data: { generated: 1, invoice_ids: ['a'], errors: [] } });
      }
      return json({ data: { items: [{ id: 't1', templateName: 'Retainer', clientId: 'c', frequency: 'monthly',
        nextRunDate: '2026-01-01', runCount: 0, status: 'active', totalAmount: 1150 }] } });
    });
    render(<RecurringInvoicesPage />);
    fireEvent.click(await runDueButton());
    await turns(() => screen.getByText(/1 invoice generated/i));
    expect(screen.queryByText(/held for approval/i)).toBeNull();
  });
});
