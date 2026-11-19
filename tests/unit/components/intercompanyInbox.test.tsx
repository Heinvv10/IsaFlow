// Bills > Intercompany inbox: load and filter, review then accept, reject needs a reason, dismiss and restore, a viewer's read-only list,
// blockers disable Accept, and the Bills tab badge.
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

const h = vi.hoisted(() => ({ role: 'owner' as string }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: h.role }) }));
vi.mock('next/router', () => ({ useRouter: () => ({ push: vi.fn(), query: {}, pathname: '/accounting/supplier-invoices/intercompany' }) }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
useApiJsonOverMock();

import { apiFetch } from '@/lib/apiFetch';
import IntercompanyInboxPage from '../../../pages/accounting/supplier-invoices/intercompany';
import { StatusTabs } from '@/components/accounting/supplier-invoices/StatusTabs';
import { envelope, failure } from './intercompanyFixtures';
import type { InboxDetail, InboxItem } from '@/modules/accounting/services/intercompany/inboxTypes';

const item = (over: Partial<InboxItem> = {}): InboxItem => ({
  id: 'm-1', kind: 'invoice', status: 'pending', connectionId: 'c-1', senderName: 'Blitz Fibre', number: 'INV-100', date: '2026-11-18', dueDate: '2026-12-18',
  currency: 'ZAR', subtotal: 1000, taxAmount: 150, total: 1150, notes: null, creditsInvoiceNumber: null, lineCount: 2, hasPdf: true, blocker: null,
  reason: null, error: null, handledAt: null, handledVia: null, targetDocType: null, targetDocId: null, createdAt: '2026-11-18T10:00:00.000Z', ...over,
});
const detail = (over: Partial<InboxDetail> = {}): InboxDetail => ({
  item: item(),
  lines: [
    { index: 0, description: 'Fibre install', quantity: 2, unitPrice: 300, taxRate: 15, taxAmount: 90, lineTotal: 600, accountId: 'acc-1', accountLabel: '5000 Fees', accountSource: 'default' },
    { index: 1, description: 'Router', quantity: 1, unitPrice: 400, taxRate: 15, taxAmount: 60, lineTotal: 400, accountId: null, accountLabel: null, accountSource: null },
  ],
  supplier: { id: 's-1', name: 'Blitz Fibre (supplier)' }, duplicateOf: null, blockers: [],
  accounts: [{ id: 'acc-1', label: '5000 Fees' }, { id: 'acc-2', label: '5100 Consumables' }], ...over,
});

interface Serve { items?: InboxItem[]; detail?: InboxDetail; post?: (url: string, body: unknown) => Response }
function serve(s: Serve = {}) {
  vi.mocked(apiFetch).mockImplementation(async (url: unknown, init?: unknown) => {
    const u = String(url);
    const i = init as RequestInit | undefined;
    if (i?.method === 'POST') return s.post?.(u, i.body ? JSON.parse(String(i.body)) : undefined) ?? envelope({});
    if (u.includes('/inbox?')) {
      const items = (s.items ?? [item()]).filter((x) => (u.includes('filter=handled') ? !['pending', 'failed'].includes(x.status) : ['pending', 'failed'].includes(x.status)));
      return envelope({ items, total: items.length, openCount: (s.items ?? [item()]).filter((x) => ['pending', 'failed'].includes(x.status)).length });
    }
    if (/\/inbox\/[^/]+$/.test(u)) return envelope(s.detail ?? detail());
    return envelope({});
  });
}
const posts = () => vi.mocked(apiFetch).mock.calls.filter(([, i]) => (i as RequestInit | undefined)?.method === 'POST');

beforeEach(() => { h.role = 'owner'; vi.mocked(apiFetch).mockReset(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('IntercompanyInboxPage', () => {
  it('lists what needs a person with the sender, number, total and a Waiting status', async () => {
    serve();
    render(<IntercompanyInboxPage />);
    const row = await screen.findByTestId('inbox-row');
    expect(within(row).getByText('Blitz Fibre')).toBeInTheDocument();
    expect(within(row).getByText('INV-100')).toBeInTheDocument();
    expect(within(row).getByText('Waiting')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Needs you \(1\)/ })).toBeInTheDocument();
  });

  it('a credit note is shown as a negative total', async () => {
    serve({ items: [item({ kind: 'credit_note', number: 'CN-7', total: 230 })] });
    render(<IntercompanyInboxPage />);
    const row = await screen.findByTestId('inbox-row');
    expect(row.textContent).toMatch(/-/);
    expect(within(row).getByText('Credit note')).toBeInTheDocument();
  });

  it('says so when nothing waits', async () => {
    serve({ items: [] });
    render(<IntercompanyInboxPage />);
    expect(await screen.findByText('Nothing waiting for you')).toBeInTheDocument();
  });

  it('review loads the message, takes the chosen accounts, and accept posts exactly those', async () => {
    serve({ post: () => envelope({ messageId: 'm-1', targetDocType: 'supplier_invoice', targetDocId: 'bill-1', linkId: 'l-1', pdfCopied: true }) });
    render(<IntercompanyInboxPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Review' }));
    await screen.findByText('Draft goes on supplier');
    expect(screen.getByText('Blitz Fibre (supplier)')).toBeInTheDocument();
    const accept = screen.getByRole('button', { name: 'Accept as draft' });
    expect(accept).toBeDisabled(); // line 2 has no account yet
    fireEvent.change(screen.getByLabelText('Account for line 2'), { target: { value: 'acc-2' } });
    expect(accept).toBeEnabled();
    fireEvent.click(accept);
    await screen.findByText(/Accepted INV-100 as a draft/);
    const [url, init] = posts()[0]!;
    expect(String(url)).toBe('/api/accounting/intercompany/inbox/m-1/accept');
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ lineAccounts: { 0: 'acc-1', 1: 'acc-2' } });
    expect(screen.getByRole('link', { name: 'Open the draft' })).toHaveAttribute('href', '/accounting/supplier-invoices/bill-1');
  });

  it('a blocker (foreign currency, duplicate, no supplier) is shown and Accept stays disabled', async () => {
    serve({ detail: detail({ blockers: ['This invoice is in USD. Intercompany mirroring is ZAR only: reject it, and capture it by hand.'] }) });
    render(<IntercompanyInboxPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Review' }));
    expect(await screen.findByTestId('inbox-blockers')).toHaveTextContent('ZAR only');
    fireEvent.change(screen.getByLabelText('Account for line 2'), { target: { value: 'acc-2' } });
    expect(screen.getByRole('button', { name: 'Accept as draft' })).toBeDisabled();
  });

  it('a refusal from the server is shown in the dialog and nothing closes', async () => {
    serve({ post: () => failure('A bill numbered INV-100 already exists for this supplier.', 409) });
    render(<IntercompanyInboxPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Review' }));
    await screen.findByText('Draft goes on supplier');
    fireEvent.change(screen.getByLabelText('Account for line 2'), { target: { value: 'acc-2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Accept as draft' }));
    expect(await screen.findByText(/already exists for this supplier/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Accept as draft' })).toBeInTheDocument();
  });

  it('reject asks for a reason first, then posts it trimmed', async () => {
    serve();
    render(<IntercompanyInboxPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Reject' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Reject message' }));
    expect(await screen.findByText(/Say why you are rejecting it/)).toBeInTheDocument();
    expect(posts()).toHaveLength(0);
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: '  Not ours  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reject message' }));
    await screen.findByText(/Rejected INV-100/);
    const [url, init] = posts()[0]!;
    expect(String(url)).toBe('/api/accounting/intercompany/inbox/m-1/reject');
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ reason: 'Not ours' });
  });

  it('dismiss posts and says it can be restored; a dismissed one offers Restore under Handled', async () => {
    serve({ items: [item(), item({ id: 'm-2', number: 'INV-200', status: 'dismissed' })] });
    render(<IntercompanyInboxPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss' }));
    await screen.findByText(/Dismissed INV-100/);
    expect(String(posts()[0]![0])).toBe('/api/accounting/intercompany/inbox/m-1/dismiss');
    fireEvent.click(screen.getByRole('button', { name: 'Handled' }));
    fireEvent.click(await screen.findByRole('button', { name: /Restore/ }));
    await waitFor(() => expect(posts().some(([u]) => String(u).endsWith('/inbox/m-2/restore'))).toBe(true));
  });

  it('a handled list shows the reason of a rejection, "accepted automatically", and links to the draft', async () => {
    serve({ items: [
      item({ id: 'a', number: 'INV-1', status: 'accepted', handledVia: 'auto', targetDocType: 'supplier_invoice', targetDocId: 'bill-9' }),
      item({ id: 'r', number: 'INV-2', status: 'rejected', reason: 'Wrong entity' }),
    ] });
    render(<IntercompanyInboxPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Handled' }));
    expect(await screen.findByText('Accepted automatically')).toBeInTheDocument();
    expect(screen.getByText('Reason: Wrong entity')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open draft' })).toHaveAttribute('href', '/accounting/supplier-invoices/bill-9');
  });

  it('a failed automatic acceptance shows its sentence and offers to review and retry', async () => {
    serve({ items: [item({ status: 'failed', error: 'Link the supplier for this connection first.' })] });
    render(<IntercompanyInboxPage />);
    expect(await screen.findByText('Link the supplier for this connection first.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Review and retry' })).toBeInTheDocument();
  });

  it('a viewer reads the list and has no action buttons', async () => {
    h.role = 'viewer';
    serve();
    render(<IntercompanyInboxPage />);
    await screen.findByTestId('inbox-row');
    for (const name of ['Review', 'Reject', 'Dismiss']) expect(screen.queryByRole('button', { name })).toBeNull();
  });

  it('a failed load says so and offers a retry, keeping the page', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => failure('boom', 500));
    render(<IntercompanyInboxPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/boom|Could not load/);
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});

describe('the Intercompany tab on the Bills strip', () => {
  it('shows the count of what needs a person, and nothing when there is none', () => {
    const { rerender } = render(<StatusTabs active="all" counts={{}} onChange={() => undefined} intercompany={{ count: 3, active: false }} />);
    expect(screen.getByTestId('intercompany-tab')).toHaveAttribute('href', '/accounting/supplier-invoices/intercompany');
    expect(screen.getByTestId('intercompany-badge')).toHaveTextContent('3');
    rerender(<StatusTabs active="all" counts={{}} onChange={() => undefined} intercompany={{ count: 0, active: false }} />);
    expect(screen.queryByTestId('intercompany-badge')).toBeNull();
    expect(screen.getByTestId('intercompany-tab')).toBeInTheDocument();
  });

  it('is absent for a company with no intercompany connection', () => {
    render(<StatusTabs active="all" counts={{}} onChange={() => undefined} intercompany={null} />);
    expect(screen.queryByTestId('intercompany-tab')).toBeNull();
  });

  it('marks itself current on the inbox page, where no status tab is selected', () => {
    render(<StatusTabs active={null} counts={{}} onChange={() => undefined} intercompany={{ count: 0, active: true }} />);
    expect(screen.getByTestId('intercompany-tab')).toHaveAttribute('aria-current', 'page');
  });
});
