// Intercompany F, review round 1 (UI): accept actions only while the state word is `open` (B4); the draft form's confirmation when receipts
// may already hold the payment (LOW-2); the receipt chip asks nothing with the flag off (B8) and offers the discard of an orphan F draft (LOW-3).
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

const nav = vi.hoisted(() => ({ flags: new Set<string>(['intercompany_loan_clearing']) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: 'owner' }) }));
vi.mock('next/router', () => ({ useRouter: () => ({ push: vi.fn(), query: {}, pathname: '/accounting/customer-payments/intercompany' }) }));
vi.mock('@/hooks/useNavFlags', () => ({ useNavFlags: () => nav.flags }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
useApiJsonOverMock();

import { apiFetch } from '@/lib/apiFetch';
import IntercompanyPaymentsPage from '../../../pages/accounting/customer-payments/intercompany';
import { ReceiptIcChip } from '@/components/accounting/intercompany/payments/ReceiptIcChip';
import { envelope } from './intercompanyFixtures';
import type { PaymentDetail, PaymentItem } from '@/modules/accounting/services/intercompany/paymentInboxTypes';

const item = (over: Partial<PaymentItem> = {}): PaymentItem => ({
  id: 'm-1', status: 'pending', connectionId: 'c-1', senderName: 'Velocity Fibre', paymentNumber: 'SP-7', paymentReference: 'ref 7', paymentDate: '2026-09-01',
  paymentMethod: 'eft', amount: 1150, currency: 'ZAR', payerDocumentNumber: 'B-1', payerDocumentDate: '2026-08-01',
  issuerInvoice: { id: 'inv-1', number: 'INV-900', status: 'approved', openAmount: 1150, currency: 'ZAR', date: '2026-09-01' },
  state: 'open', live: true, reason: null, error: null, handledAt: null, createdAt: '2026-09-01T10:00:00.000Z', target: null, ...over,
});
const detail = (i: PaymentItem, over: Partial<PaymentDetail['suggestions'] & object> = {}): PaymentDetail => ({
  item: i, allocationId: 'a-1', linkId: 'l-1', cutoverDate: '2026-01-01', enabled: true,
  suggestions: {
    invoices: [{ id: 'inv-1', number: 'INV-900', date: '2026-09-01', openAmount: 1150, linked: true }],
    receipts: [{ id: 'r-1', number: 'RC-1', date: '2026-09-02', total: 5000, unallocated: 5000, unconsumed: 5000, exact: false, onLinkedInvoice: false, score: 60 }],
    bankLines: [], bankAccounts: [{ id: 'bank-1', label: '1000 Bank' }], draftAllowed: true, draftRefusal: null, today: '2026-11-24',
    holderCount: 0, holders: [], ...over,
  },
});

function serve(i: PaymentItem, d: PaymentDetail) {
  vi.mocked(apiFetch).mockImplementation(async (url: unknown, init?: unknown) => {
    const u = String(url);
    if (u.includes('/payments/unsent')) return envelope({ state: 'ok', sentence: null, items: [] });
    if (u.includes('/payments?')) return envelope({ items: [i], total: 1, openCount: 1, enabled: true });
    if (/\/payments\/m-1$/.test(u)) return envelope(d);
    if ((init as RequestInit | undefined)?.method === 'POST') return envelope({ accepted: true, messageId: 'm-1', outcome: 'draft', receiptId: 'r-2', receiptNumber: 'RC-2' });
    return envelope(null);
  });
}
const posts = () => vi.mocked(apiFetch).mock.calls.filter(([, i]) => (i as RequestInit | undefined)?.method === 'POST')
  .map(([u, i]) => ({ url: String(u), body: JSON.parse(String((i as RequestInit).body ?? '{}')) as Record<string, unknown> }));

beforeEach(() => { vi.mocked(apiFetch).mockReset(); nav.flags = new Set(['intercompany_loan_clearing']); });
afterEach(() => { vi.restoreAllMocks(); });

async function openDrawer() {
  render(<IntercompanyPaymentsPage />);
  const list = await screen.findByRole('region', { name: 'Payments from your group' });
  fireEvent.click(within(list).getByRole('button', { name: 'Details for payment SP-7' }));
  return screen.findByRole('dialog');
}

describe('B4: accept actions only while the state word is open', () => {
  it.each(['payer_gone', 'link_gone', 'not_cash', 'check_failed'] as const)('a pending message whose word is %s offers no match and no draft; Reject stays', async (state) => {
    const i = item({ state, live: false });
    serve(i, detail(i));
    const drawer = await openDrawer();
    await within(drawer).findByRole('list', { name: 'Your open invoices' });
    expect(within(drawer).queryByRole('button', { name: /This is my receipt/ })).toBeNull();
    expect(within(drawer).queryByRole('button', { name: /Draft a receipt/ })).toBeNull();
    expect(within(drawer).getByRole('button', { name: 'Reject payment SP-7' })).toBeInTheDocument();
  });

  it('control: open offers both', async () => {
    serve(item(), detail(item()));
    const drawer = await openDrawer();
    expect(await within(drawer).findByRole('button', { name: 'This is my receipt RC-1' })).toBeInTheDocument();
    expect(within(drawer).getByRole('button', { name: 'Draft a receipt for payment SP-7' })).toBeInTheDocument();
  });
});

describe('LOW-2: receipts that may already hold the payment', () => {
  it('the draft form lists them and posts only after the person confirms none holds it, with the count they saw', async () => {
    serve(item(), detail(item(), { holderCount: 1, holders: [{ id: 'r-5', number: 'RC-5', date: '2026-09-03', unconsumed: 1150 }] }));
    const drawer = await openDrawer();
    fireEvent.click(await within(drawer).findByRole('button', { name: 'Draft a receipt for payment SP-7' }));
    const form = await screen.findByRole('form', { name: 'Draft a receipt' });
    expect(within(form).getByText(/RC-5/)).toBeInTheDocument();
    const when = within(form).getByLabelText('Receipt date');
    fireEvent.change(when, { target: { value: '2026-09-02' } });
    fireEvent.blur(when);
    fireEvent.click(within(form).getByRole('button', { name: 'Create draft receipt' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent(/none of these receipts/i);
    expect(posts()).toHaveLength(0);
    fireEvent.click(within(form).getByRole('checkbox', { name: /None of these receipts holds this payment/ }));
    fireEvent.click(within(form).getByRole('button', { name: 'Create draft receipt' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]!.body).toMatchObject({ confirmNoHolder: true, expected: { amount: 1150, state: 'open', invoiceIds: ['inv-1'], holderCount: 1 } });
  });
});

describe('the receipt chip', () => {
  it('B8: with the flag off it asks nothing', async () => {
    nav.flags = new Set();
    vi.mocked(apiFetch).mockImplementation(async () => envelope({ messageId: 'm-1', state: 'target_ok', status: 'accepted' }));
    const { container } = render(<ReceiptIcChip receiptId="r-1" paymentNumber="RC-1" />);
    await new Promise((r) => setTimeout(r, 20));
    expect(vi.mocked(apiFetch).mock.calls.filter(([u]) => String(u).includes('receipt-state'))).toHaveLength(0);
    expect(container.textContent).toBe('');
  });

  it('LOW-3: an orphan F draft says its message is missing and offers the discard (by the stamped id)', async () => {
    const changed = vi.fn();
    vi.mocked(apiFetch).mockImplementation(async (url: unknown, init?: unknown) => (
      (init as RequestInit | undefined)?.method === 'POST' ? envelope({ messageId: 's-1', status: 'no_message', paymentId: 'r-3' })
        : envelope({ messageId: 's-1', state: 'not_found', status: 'orphan' })));
    render(<ReceiptIcChip receiptId="r-3" paymentNumber="RC-3" onChanged={changed} />);
    expect(await screen.findByText('Intercompany: its message is missing')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Discard draft RC-3' }));
    fireEvent.change(await screen.findByLabelText('Reason'), { target: { value: 'message gone' } });
    fireEvent.click(screen.getByRole('button', { name: 'Discard the draft' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]).toEqual({ url: '/api/accounting/intercompany/payments/s-1/discard-draft', body: { paymentId: 'r-3', reason: 'message gone' } });
    await waitFor(() => expect(changed).toHaveBeenCalled());
  });
});
