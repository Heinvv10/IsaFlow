// Bills > Intercompany, "Payments from your group" (P4-C): the payer's allocation messages under the invoice list, shown only when there
// is one; each row's state (Live, Stale: <reason>, Check: <mismatch>); the detail drawer with the payload facts; Reject (reason required)
// and Dismiss (confirmed first), Restore of a dismissed one; Accept only in the drawer (P4-D, its own tests); a viewer reads only. Every action
// button names its payment (screen readers hear which row).
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
import { formatCurrency, formatDate } from '@/utils/formatters';
import { envelope } from './intercompanyFixtures';
import { alloc, detailOf, posts, serve } from './intercompanyInboxFixtures';

beforeEach(() => { h.role = 'owner'; vi.mocked(apiFetch).mockReset(); });
afterEach(() => { vi.restoreAllMocks(); });

const STALE = alloc({ id: 'a-2', paymentNumber: 'SP-00013', live: false, liveReason: 'allocation_gone' });
const CHECK = alloc({ id: 'a-3', paymentNumber: 'SP-00014', mismatch: 'amount_exceeds_open', issuerInvoice: { ...alloc().issuerInvoice!, openAmount: 100 } });

const section = () => screen.findByRole('region', { name: 'Payments from your group' });

describe('Payments from your group', () => {
  it('lists each payment under the invoices with payer, payment, your invoice, amount, open amount and its state', async () => {
    serve({ items: [], allocations: [alloc(), STALE, CHECK] });
    render(<IntercompanyInboxPage />);
    const rows = within(await section()).getAllByTestId('allocation-row');
    expect(rows).toHaveLength(3);
    const live = rows[0]!;
    expect(within(live).getByText('Velocity Fibre (customer)')).toBeInTheDocument();
    expect(live.textContent).toContain('IC alloc ref');
    expect(within(live).getByText('INV-900')).toBeInTheDocument();
    expect(live.textContent).toContain(formatCurrency(1150));
    expect(live.textContent).toContain(formatCurrency(2000));
    expect(within(live).getByTestId('allocation-state')).toHaveTextContent('Live');
    expect(within(rows[1]!).getByTestId('allocation-state')).toHaveTextContent('Stale: the payment was unapplied');
    expect(within(rows[2]!).getByTestId('allocation-state')).toHaveTextContent('Check: more than the invoice\'s open amount');
    expect(within(await section()).getByRole('table', { name: /Payments from your group/ })).toBeInTheDocument();   // the table's caption
    for (const name of ['Details for payment SP-00012 on INV-900', 'Reject payment SP-00012 on INV-900', 'Dismiss payment SP-00012 on INV-900', 'Details for payment SP-00013 on INV-900']) {
      expect(within(await section()).getByRole('button', { name })).toBeInTheDocument();
    }
  });

  it('is not shown when there are no payments (judged after the answer arrives), and asks for the same filter as the invoice list', async () => {
    serve({ allocations: [] });
    const real = vi.mocked(apiFetch).getMockImplementation()!;
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => { release = r; });
    vi.mocked(apiFetch).mockImplementation(async (url: unknown, init?: unknown) => {
      if (String(url).includes('/allocations?filter=open')) await held;
      return real(url as never, init as never);
    });
    render(<IntercompanyInboxPage />);
    await screen.findByTestId('inbox-row');
    await act(async () => { release(); await held; });
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(screen.queryByRole('region', { name: 'Payments from your group' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Handled' }));
    await waitFor(() => expect(vi.mocked(apiFetch).mock.calls.some(([u]) => String(u).includes('/allocations?filter=handled'))).toBe(true));
  });

  it('a slow answer for the earlier filter never replaces the newer one', async () => {
    let releaseOpen: (r: Response) => void = () => undefined;
    serve({ items: [] });
    const real = vi.mocked(apiFetch).getMockImplementation()!;
    vi.mocked(apiFetch).mockImplementation(async (url: unknown, init?: unknown) => {
      const u = String(url);
      if (u.includes('/allocations?filter=open')) return new Promise<Response>((r) => { releaseOpen = r; });
      if (u.includes('/allocations?filter=handled')) return envelope({ items: [alloc({ id: 'h-1', paymentNumber: 'SP-HANDLED', status: 'dismissed', live: false, liveReason: 'not_pending' })], total: 1, allocationCount: 0 });
      return real(url as never, init as never);
    });
    render(<IntercompanyInboxPage />);
    await waitFor(() => expect(vi.mocked(apiFetch).mock.calls.some(([u]) => String(u).includes('/allocations?filter=open'))).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'Handled' }));
    await within(await section()).findByText('SP-HANDLED');
    await act(async () => { releaseOpen(envelope({ items: [alloc({ paymentNumber: 'SP-STALE' })], total: 1, allocationCount: 1 })); });
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByText('SP-STALE')).toBeNull();
    expect(screen.getByText('SP-HANDLED')).toBeInTheDocument();
  });

  it('the invoice list\'s empty state does not say nothing is waiting while payments are listed; the subtitle names payments', async () => {
    serve({ items: [], allocations: [alloc()] });
    render(<IntercompanyInboxPage />);
    await section();
    expect(await screen.findByText('No invoices or credit notes waiting')).toBeInTheDocument();
    expect(screen.queryByText('Nothing waiting for you')).toBeNull();
    expect(screen.getByText(/and the payments they applied to your invoices/)).toBeInTheDocument();
  });

  it('with nothing at all the invoice list still says nothing is waiting', async () => {
    serve({ items: [], allocations: [] });
    render(<IntercompanyInboxPage />);
    expect(await screen.findByText('Nothing waiting for you')).toBeInTheDocument();
  });

  it('an invoice that is not open shows no open amount and says so', async () => {
    serve({ items: [], allocations: [alloc({ issuerInvoice: { ...alloc().issuerInvoice!, status: 'draft', openAmount: null }, mismatch: 'invoice_not_open' })] });
    render(<IntercompanyInboxPage />);
    const row = within(await section()).getByTestId('allocation-row');
    expect(within(row).getByTestId('allocation-state')).toHaveTextContent('Check: your invoice is not open');
    expect(row.textContent).not.toContain(formatCurrency(2000));
  });

  it('a gone invoice and an unreadable payload show no figure they do not have', async () => {
    serve({ items: [], allocations: [alloc({ issuerInvoice: null, mismatch: 'invoice_gone' }), alloc({ id: 'a-9', amount: null, currency: null, blocker: 'The amount is not a valid amount', paymentNumber: null, paymentReference: null })] });
    render(<IntercompanyInboxPage />);
    const rows = within(await section()).getAllByTestId('allocation-row');
    expect(within(rows[0]!).getByTestId('allocation-state')).toHaveTextContent('Check: your invoice is gone');
    expect(within(rows[1]!).getByTestId('allocation-state')).toHaveTextContent('Check: The amount is not a valid amount');
    expect(rows[1]!.textContent).not.toContain(formatCurrency(1150));
  });

  it('P4-D: no Accept in the list; the drawer offers it, enabled once its preview arrives, and the section says what Accept does', async () => {
    serve({ items: [], allocations: [alloc()] });
    render(<IntercompanyInboxPage />);
    const s = await section();
    expect(within(s).queryByRole('button', { name: /accept/i })).toBeNull();
    expect(s.textContent).toMatch(/Accept one to clear it against your invoice through your intercompany loan account/);
    fireEvent.click(within(s).getByRole('button', { name: 'Details for payment SP-00012 on INV-900' }));
    const drawer = await screen.findByRole('dialog');
    await waitFor(() => expect(within(drawer).getByRole('button', { name: 'Accept payment SP-00012 on INV-900' })).toBeEnabled());
  });

  it('the detail drawer shows the payload facts', async () => {
    serve({ items: [], allocations: [alloc()], allocationDetail: detailOf(alloc({ cashLegIsLoanAccount: true })) });
    render(<IntercompanyInboxPage />);
    fireEvent.click(within(await section()).getByRole('button', { name: 'Details for payment SP-00012 on INV-900' }));
    const drawer = await screen.findByRole('dialog');
    await within(drawer).findByText('SP-00012');
    for (const text of ['BILL-7', 'INV-900', 'IC alloc ref', 'Paid through the intercompany loan account', 'Manual pairing', formatDate('2026-01-01')]) {
      expect(drawer.textContent).toContain(text);
    }
    expect(vi.mocked(apiFetch).mock.calls.some(([u]) => String(u) === '/api/accounting/intercompany/allocations/a-1')).toBe(true);
  });

  it('reject asks for a reason, then posts it trimmed to the allocation route', async () => {
    serve({ items: [], allocations: [alloc()] });
    render(<IntercompanyInboxPage />);
    fireEvent.click(within(await section()).getByRole('button', { name: 'Reject payment SP-00012 on INV-900' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Reject message' }));
    expect(await screen.findByText(/Say why you are rejecting it/)).toBeInTheDocument();
    // a payment's reason is recorded on the message: nothing shows it to the payer, so the dialog never says they will read it
    expect(screen.getByRole('dialog')).toHaveTextContent('Say why you are rejecting it: the reason is recorded on the message.');
    expect(screen.getByRole('dialog').textContent).not.toMatch(/will read/);
    expect(posts()).toHaveLength(0);
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: '  Not our payment  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reject message' }));
    await screen.findByText(/Rejected payment SP-00012 on INV-900/);
    const [url, init] = posts()[0]!;
    expect(String(url)).toBe('/api/accounting/intercompany/allocations/a-1/reject');
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ reason: 'Not our payment' });
  });

  it('dismiss asks first: cancel posts nothing; confirming posts to the allocation route and says so', async () => {
    serve({ items: [], allocations: [alloc()] });
    render(<IntercompanyInboxPage />);
    fireEvent.click(within(await section()).getByRole('button', { name: 'Dismiss payment SP-00012 on INV-900' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(posts()).toHaveLength(0);
    fireEvent.click(within(await section()).getByRole('button', { name: 'Dismiss payment SP-00012 on INV-900' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss payment' }));
    await screen.findByText(/Dismissed payment SP-00012 on INV-900/);
    expect(posts().map(([u]) => String(u))).toEqual(['/api/accounting/intercompany/allocations/a-1/dismiss']);
  });

  it('a dismissed payment offers Restore under Handled, which posts to the allocation route', async () => {
    serve({ items: [], allocations: [alloc({ status: 'dismissed', live: false, liveReason: 'not_pending' })] });
    render(<IntercompanyInboxPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Handled' }));
    const row = within(await section()).getByTestId('allocation-row');
    expect(within(row).queryByRole('button', { name: /^Reject/ })).toBeNull();
    fireEvent.click(within(row).getByRole('button', { name: 'Restore payment SP-00012 on INV-900' }));
    await screen.findByText(/Restored payment SP-00012 on INV-900/);
    expect(posts().map(([u]) => String(u))).toEqual(['/api/accounting/intercompany/allocations/a-1/restore']);
  });

  it('a viewer reads the payments and the drawer, with no Reject or Dismiss', async () => {
    h.role = 'viewer';
    serve({ items: [], allocations: [alloc()], allocationDetail: detailOf(alloc()) });
    render(<IntercompanyInboxPage />);
    const s = await section();
    for (const name of [/^Reject/, /^Dismiss/, /^Restore/]) expect(within(s).queryByRole('button', { name })).toBeNull();
    fireEvent.click(within(s).getByRole('button', { name: 'Details for payment SP-00012 on INV-900' }));
    const drawer = await screen.findByRole('dialog');
    await within(drawer).findByText('SP-00012');
    for (const name of [/^Reject/, /^Dismiss/]) expect(within(drawer).queryByRole('button', { name })).toBeNull();
  });

  it('a handled payment shows its status and no actions', async () => {
    serve({ items: [], allocations: [alloc({ status: 'rejected', reason: 'Not ours', live: false, liveReason: 'not_pending' })] });
    render(<IntercompanyInboxPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Handled' }));
    const row = within(await section()).getByTestId('allocation-row');
    expect(row.textContent).toContain('Rejected');
    expect(row.textContent).toContain('Reason: Not ours');
    for (const name of [/^Reject/, /^Dismiss/, /^Restore/]) expect(within(row).queryByRole('button', { name })).toBeNull();
  });

  it('a failed load of the payments says so with a retry, and the invoice list stands', async () => {
    serve({ allocationsFail: true });
    render(<IntercompanyInboxPage />);
    await screen.findByTestId('inbox-row');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/payments from your group/i);
    vi.mocked(apiFetch).mockImplementation(async (url: unknown) =>
      (String(url).includes('/allocations?') ? envelope({ items: [alloc()], total: 1, allocationCount: 1 }) : envelope({ items: [], total: 0, openCount: 0 })));
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await section()).toBeInTheDocument();
  });
});
