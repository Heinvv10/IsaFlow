// Bills > Intercompany, "Payments from your group" (P4-C): the payer's allocation messages under the invoice list, shown only when there
// is one; each row's state (Live, Stale: <reason>, Check: <mismatch>); the detail drawer with the payload facts; Reject (reason required)
// and Dismiss; NO Accept anywhere (clearing comes later); a viewer reads only.
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
import { formatCurrency, formatDate } from '@/utils/formatters';
import { envelope } from './intercompanyFixtures';
import { posts, serve } from './intercompanyInboxFixtures';
import type { AllocationDetail, AllocationItem } from '@/modules/accounting/services/intercompany/allocationInboxTypes';

const alloc = (over: Partial<AllocationItem> = {}): AllocationItem => ({
  id: 'a-1', status: 'pending', connectionId: 'c-1', senderName: 'Velocity Fibre (customer)', paymentNumber: 'SP-00012', paymentDate: '2026-09-01',
  paymentMethod: 'eft', paymentReference: 'IC alloc ref', amount: 1150, currency: 'ZAR', payerDocumentNumber: 'BILL-7', cashLegIsLoanAccount: false,
  issuerInvoice: { id: 'inv-1', number: 'INV-900', openAmount: 2000, status: 'approved', currency: 'ZAR', date: '2026-09-01' },
  live: true, liveReason: 'ok', mismatch: null, blocker: null, reason: null, error: null, handledAt: null, createdAt: '2026-11-23T08:00:00.000Z', ...over,
});
const detailOf = (item: AllocationItem): AllocationDetail => ({ item, allocationId: 'pa-1', linkId: 'l-1', linkOrigin: 'manual_pairing', cutoverDate: '2026-01-01' });

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
  });

  it('is not shown when there are no payments, and asks for the same filter as the invoice list', async () => {
    serve({ allocations: [] });
    render(<IntercompanyInboxPage />);
    await screen.findByTestId('inbox-row');
    await waitFor(() => expect(vi.mocked(apiFetch).mock.calls.some(([u]) => String(u).includes('/allocations?filter=open'))).toBe(true));
    expect(screen.queryByRole('region', { name: 'Payments from your group' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Handled' }));
    await waitFor(() => expect(vi.mocked(apiFetch).mock.calls.some(([u]) => String(u).includes('/allocations?filter=handled'))).toBe(true));
  });

  it('a gone invoice and an unreadable payload show no figure they do not have', async () => {
    serve({ items: [], allocations: [alloc({ issuerInvoice: null, mismatch: 'invoice_gone' }), alloc({ id: 'a-9', amount: null, currency: null, blocker: 'The amount is not a valid amount', paymentNumber: null, paymentReference: null })] });
    render(<IntercompanyInboxPage />);
    const rows = within(await section()).getAllByTestId('allocation-row');
    expect(within(rows[0]!).getByTestId('allocation-state')).toHaveTextContent('Check: your invoice is gone');
    expect(within(rows[1]!).getByTestId('allocation-state')).toHaveTextContent('Check: The amount is not a valid amount');
    expect(rows[1]!.textContent).not.toContain(formatCurrency(1150));
  });

  it('has no Accept anywhere and says clearing is coming', async () => {
    serve({ items: [], allocations: [alloc()] });
    render(<IntercompanyInboxPage />);
    const s = await section();
    expect(within(s).queryByRole('button', { name: /accept/i })).toBeNull();
    expect(s.textContent).toMatch(/clearing.*coming/i);
    fireEvent.click(within(s).getByRole('button', { name: 'Details' }));
    const drawer = await screen.findByRole('dialog');
    expect(within(drawer).queryByRole('button', { name: /accept/i })).toBeNull();
  });

  it('the detail drawer shows the payload facts', async () => {
    serve({ items: [], allocations: [alloc()], allocationDetail: detailOf(alloc({ cashLegIsLoanAccount: true })) });
    render(<IntercompanyInboxPage />);
    fireEvent.click(within(await section()).getByRole('button', { name: 'Details' }));
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
    fireEvent.click(within(await section()).getByRole('button', { name: 'Reject' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Reject message' }));
    expect(await screen.findByText(/Say why you are rejecting it/)).toBeInTheDocument();
    expect(posts()).toHaveLength(0);
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: '  Not our payment  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reject message' }));
    await screen.findByText(/Rejected SP-00012/);
    const [url, init] = posts()[0]!;
    expect(String(url)).toBe('/api/accounting/intercompany/allocations/a-1/reject');
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ reason: 'Not our payment' });
  });

  it('dismiss posts to the allocation route and says so', async () => {
    serve({ items: [], allocations: [alloc()] });
    render(<IntercompanyInboxPage />);
    fireEvent.click(within(await section()).getByRole('button', { name: 'Dismiss' }));
    await screen.findByText(/Dismissed payment SP-00012/);
    expect(String(posts()[0]![0])).toBe('/api/accounting/intercompany/allocations/a-1/dismiss');
  });

  it('a viewer reads the payments and the drawer, with no Reject or Dismiss', async () => {
    h.role = 'viewer';
    serve({ items: [], allocations: [alloc()], allocationDetail: detailOf(alloc()) });
    render(<IntercompanyInboxPage />);
    const s = await section();
    for (const name of ['Reject', 'Dismiss']) expect(within(s).queryByRole('button', { name })).toBeNull();
    fireEvent.click(within(s).getByRole('button', { name: 'Details' }));
    const drawer = await screen.findByRole('dialog');
    await within(drawer).findByText('SP-00012');
    for (const name of ['Reject', 'Dismiss']) expect(within(drawer).queryByRole('button', { name })).toBeNull();
  });

  it('a handled payment shows its status and no actions', async () => {
    serve({ items: [], allocations: [alloc({ status: 'rejected', reason: 'Not ours', live: false, liveReason: 'not_pending' })] });
    render(<IntercompanyInboxPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Handled' }));
    const row = within(await section()).getByTestId('allocation-row');
    expect(row.textContent).toContain('Rejected');
    expect(row.textContent).toContain('Reason: Not ours');
    for (const name of ['Reject', 'Dismiss']) expect(within(row).queryByRole('button', { name })).toBeNull();
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
