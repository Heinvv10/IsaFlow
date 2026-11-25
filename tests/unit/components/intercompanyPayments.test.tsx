// Sales > Intercompany payments (F): the receiver's Payments list with its state chips, the detail with match suggestions, the two accept
// outcomes ("this is my receipt" / "draft a receipt"), the discard of an F draft, no Accept while the flag is off, the payer's unsent list
// and the receipt's IC state chip.
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: 'owner' }) }));
vi.mock('next/router', () => ({ useRouter: () => ({ push: vi.fn(), query: {}, pathname: '/accounting/customer-payments/intercompany' }) }));
// the receipt chip asks only with the dark flag on (the nav's answer; round 1 B8)
vi.mock('@/hooks/useNavFlags', () => ({ useNavFlags: () => new Set(['intercompany_loan_clearing']) }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
useApiJsonOverMock();

import { apiFetch } from '@/lib/apiFetch';
import IntercompanyPaymentsPage from '../../../pages/accounting/customer-payments/intercompany';
import { ReceiptIcChip } from '@/components/accounting/intercompany/payments/ReceiptIcChip';
import { envelope } from './intercompanyFixtures';
import type { PaymentDetail, PaymentItem, PaymentPage } from '@/modules/accounting/services/intercompany/paymentInboxTypes';

const item = (over: Partial<PaymentItem> = {}): PaymentItem => ({
  id: 'm-1', status: 'pending', connectionId: 'c-1', senderName: 'Velocity Fibre', paymentNumber: 'SP-7', paymentReference: 'ref 7', paymentDate: '2026-09-01',
  paymentMethod: 'eft', amount: 1150, currency: 'ZAR', payerDocumentNumber: 'B-1', payerDocumentDate: '2026-08-01',
  issuerInvoice: { id: 'inv-1', number: 'INV-900', status: 'approved', openAmount: 1150, currency: 'ZAR', date: '2026-09-01' },
  state: 'open', live: true, reason: null, error: null, handledAt: null, createdAt: '2026-09-01T10:00:00.000Z', target: null, ...over,
});
const detail = (i: PaymentItem, over: Partial<PaymentDetail> = {}): PaymentDetail => ({
  item: i, allocationId: 'a-1', linkId: 'l-1', cutoverDate: '2026-01-01', enabled: true,
  suggestions: {
    invoices: [{ id: 'inv-1', number: 'INV-900', date: '2026-09-01', openAmount: 1150, linked: true }, { id: 'inv-2', number: 'INV-901', date: '2026-09-05', openAmount: 500, linked: false }],
    receipts: [{ id: 'r-1', number: 'RC-1', date: '2026-09-02', total: 1150, unallocated: 1150, unconsumed: 1150, exact: true, onLinkedInvoice: false, score: 80 }],
    bankLines: [{ id: 'bt-1', date: '2026-09-02', amount: 1150, description: 'VELOCITY 7', score: 70 }],
    bankAccounts: [{ id: 'bank-1', label: '1000 Bank' }], draftAllowed: false, draftRefusal: 'exact_receipt', today: '2026-11-24',
    holderCount: 0, holders: [],
  },
  ...over,
});

function serve(page: Partial<PaymentPage> & { items: PaymentItem[] }, d?: PaymentDetail, unsent: unknown = { state: 'ok', sentence: null, items: [] }) {
  vi.mocked(apiFetch).mockImplementation(async (url: unknown, init?: unknown) => {
    const u = String(url);
    if (u.includes('/payments/unsent')) return envelope(unsent);
    if (u.includes('/payments?')) return envelope({ total: page.items.length, openCount: page.items.length, enabled: true, ...page });
    if (/\/payments\/m-1$/.test(u)) return envelope(d ?? detail(page.items[0]!));
    if ((init as RequestInit | undefined)?.method === 'POST') return envelope({ accepted: true, messageId: 'm-1', outcome: 'existing', receiptId: 'r-1', receiptNumber: 'RC-1' });
    return envelope(null);
  });
}
const posts = () => vi.mocked(apiFetch).mock.calls.filter(([, i]) => (i as RequestInit | undefined)?.method === 'POST')
  .map(([u, i]) => ({ url: String(u), body: JSON.parse(String((i as RequestInit).body ?? '{}')) as Record<string, unknown> }));

beforeEach(() => { vi.mocked(apiFetch).mockReset(); });
afterEach(() => { vi.restoreAllMocks(); });

async function openDrawer() {
  render(<IntercompanyPaymentsPage />);
  const list = await screen.findByRole('region', { name: 'Payments from your group' });
  fireEvent.click(within(list).getByRole('button', { name: 'Details for payment SP-7' }));
  return screen.findByRole('dialog');
}

describe('the Payments list', () => {
  it('shows each payment with its state chip', async () => {
    serve({ items: [item(), item({ id: 'm-2', paymentNumber: 'SP-8', state: 'payer_gone', live: false })] });
    render(<IntercompanyPaymentsPage />);
    const list = await screen.findByRole('region', { name: 'Payments from your group' });
    expect(within(list).getByText('Open')).toBeInTheDocument();
    expect(within(list).getByText('Payer voided or changed it')).toBeInTheDocument();
  });

  it('with the flag off: no Accept and no suggestions are offered', async () => {
    serve({ items: [item()], enabled: false }, detail(item(), { enabled: false, suggestions: null }));
    const drawer = await openDrawer();
    await waitFor(() => expect(within(drawer).queryByText(/Loading/)).toBeNull());
    expect(within(drawer).queryByRole('button', { name: /This is my receipt/ })).toBeNull();
    expect(within(drawer).queryByRole('button', { name: /Draft a receipt/ })).toBeNull();
    expect(within(drawer).getByRole('button', { name: 'Reject payment SP-7' })).toBeInTheDocument();
  });
});

describe('the detail and its suggestions', () => {
  it('lists the linked invoice first, the receipts and the bank lines (a hint only)', async () => {
    serve({ items: [item()] });
    const drawer = await openDrawer();
    const invoices = await within(drawer).findByRole('list', { name: 'Your open invoices' });
    expect(within(invoices).getAllByRole('listitem')[0]!.textContent).toMatch(/INV-900.*linked/i);
    expect(within(drawer).getByRole('list', { name: 'Bank lines (hint only)' }).querySelectorAll('button')).toHaveLength(0);
  });

  it('existing: "This is my receipt" posts the receipt and what the person saw', async () => {
    serve({ items: [item()] });
    const drawer = await openDrawer();
    fireEvent.click(await within(drawer).findByRole('button', { name: 'This is my receipt RC-1' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm match' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]).toEqual({ url: '/api/accounting/intercompany/payments/m-1/accept', body: { outcome: 'existing', receiptId: 'r-1', expected: { amount: 1150, state: 'open' } } });
  });

  it('draft is refused while an exact receipt exists (the form is not offered)', async () => {
    serve({ items: [item()] });
    const drawer = await openDrawer();
    expect(await within(drawer).findByText(/use the receipt above/i)).toBeInTheDocument();
    expect(within(drawer).queryByRole('button', { name: /Draft a receipt/ })).toBeNull();
  });

  it('draft: the form posts the bank account, date and allocation, and what the person saw', async () => {
    const d = detail(item());
    serve({ items: [item()] }, { ...d, suggestions: { ...d.suggestions!, receipts: [], draftAllowed: true, draftRefusal: null } });
    const drawer = await openDrawer();
    fireEvent.click(await within(drawer).findByRole('button', { name: 'Draft a receipt for payment SP-7' }));
    const form = await screen.findByRole('form', { name: 'Draft a receipt' });
    const when = within(form).getByLabelText('Receipt date');
    fireEvent.change(when, { target: { value: '2026-09-02' } });
    fireEvent.blur(when);
    fireEvent.click(within(form).getByRole('button', { name: 'Create draft receipt' }));
    await waitFor(() => expect(posts().length, form.textContent ?? '').toBeGreaterThan(0));
    expect(posts().at(-1)).toEqual({ url: '/api/accounting/intercompany/payments/m-1/accept', body: {
      outcome: 'draft', bankAccountId: 'bank-1', paymentDate: '2026-09-02', allocations: [{ invoiceId: 'inv-1', amount: 1150 }],
      expected: { amount: 1150, state: 'open', invoiceIds: ['inv-1', 'inv-2'] },
    } });
  });

  it('discard: an accepted message with an F draft offers Discard draft, which posts the receipt and a reason', async () => {
    const accepted = item({ status: 'accepted', state: 'target_ok', target: { paymentId: 'r-9', paymentNumber: 'RC-9', status: 'draft', isDraft: true } });
    serve({ items: [accepted] }, detail(accepted, { suggestions: null }));
    const drawer = await openDrawer();
    fireEvent.click(await within(drawer).findByRole('button', { name: 'Discard draft RC-9' }));
    fireEvent.change(await screen.findByLabelText('Reason'), { target: { value: 'wrong account' } });
    fireEvent.click(screen.getByRole('button', { name: 'Discard the draft' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]).toEqual({ url: '/api/accounting/intercompany/payments/m-1/discard-draft', body: { paymentId: 'r-9', reason: 'wrong account' } });
  });
});

describe('the payer side and the receipt chip', () => {
  it('the unsent list shows paid linked bills with no message', async () => {
    serve({ items: [] }, undefined, { state: 'ok', sentence: null, items: [{ allocationId: 'a-9', paymentId: 'p-9', paymentNumber: 'SP-9', paymentDate: '2026-09-01', billId: 'b-9', billNumber: 'B-9', amount: 99, partnerName: 'Velocity' }] });
    render(<IntercompanyPaymentsPage />);
    const unsent = await screen.findByRole('region', { name: 'Paid with no payment message' });
    expect(within(unsent).getByText('SP-9')).toBeInTheDocument();
  });

  it('the receipt chip says the state word of the message that targets it, and nothing otherwise', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => envelope({ messageId: 'm-1', state: 'target_ok', status: 'accepted' }));
    const { unmount } = render(<ReceiptIcChip receiptId="r-1" />);
    expect(await screen.findByText('Intercompany: matched')).toBeInTheDocument();
    unmount();
    vi.mocked(apiFetch).mockImplementation(async () => envelope(null));
    const { container } = render(<ReceiptIcChip receiptId="r-2" />);
    await waitFor(() => expect(vi.mocked(apiFetch)).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });
});
