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
import { envelope, failure } from './intercompanyFixtures';
import { formatCurrency } from '@/utils/formatters';
import { detail, item, posts, serve } from './intercompanyInboxFixtures';


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
    expect(row.textContent).toContain(formatCurrency(-230)); // the exact figure, negative: a credit
    expect(formatCurrency(-230)).not.toBe(formatCurrency(230));
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

  it('"Accepted automatically" is shown only for an ACCEPTED message, never on a failed one the worker marked', async () => {
    serve({ items: [item({ id: 'f', number: 'INV-F', status: 'failed', handledVia: 'auto', error: 'Link the supplier first.' })] });
    render(<IntercompanyInboxPage />);
    await screen.findByText('Link the supplier first.');
    expect(screen.queryByText('Accepted automatically')).toBeNull();
  });

  it('a withdrawn message reads "Cancelled by sender" with no action; an accepted one the sender cancelled says so and keeps the draft link', async () => {
    serve({ items: [
      item({ id: 'w', number: 'INV-W', status: 'withdrawn', sourceCancelled: true }),
      item({ id: 'a', number: 'INV-A', status: 'accepted', sourceCancelled: true, targetDocType: 'supplier_invoice', targetDocId: 'bill-7' }),
    ] });
    render(<IntercompanyInboxPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Handled' }));
    const rows = await screen.findAllByTestId('inbox-row');
    expect(within(rows[0]!).getByText('Cancelled by sender')).toBeInTheDocument();
    for (const name of ['Review', 'Reject', 'Dismiss', 'Restore']) expect(within(rows[0]!).queryByRole('button', { name })).toBeNull();
    expect(within(rows[1]!).getByTestId('sender-cancelled')).toHaveTextContent('Sender cancelled this document');
    expect(within(rows[1]!).getByRole('link', { name: 'Open draft' })).toHaveAttribute('href', '/accounting/supplier-invoices/bill-7');
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
