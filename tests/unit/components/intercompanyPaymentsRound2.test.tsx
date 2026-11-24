// Intercompany F, review round 2 (UI): the payer's unsent list marks a payment D1 refuses for crediting no money account (LOW-R2), and the
// receipt chip, with its Discard, shows for a receipt stamped IC:<id> whether the flag is on or off (LOW-R3: a flag-off F draft has no other
// exit); with no stamp the flag still decides whether it asks at all (B8).
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

const nav = vi.hoisted(() => ({ flags: new Set<string>() }));
vi.mock('@/hooks/useNavFlags', () => ({ useNavFlags: () => nav.flags }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
useApiJsonOverMock();

import { apiFetch } from '@/lib/apiFetch';
import { ReceiptIcChip } from '@/components/accounting/intercompany/payments/ReceiptIcChip';
import { UnsentPaymentsSection } from '@/components/accounting/intercompany/payments/UnsentPaymentsSection';
import { envelope } from './intercompanyFixtures';

const MSG = '0b6f3f1e-4c1a-4f7e-9a51-2a8d6f0c9e11';
const posts = () => vi.mocked(apiFetch).mock.calls.filter(([, i]) => (i as RequestInit | undefined)?.method === 'POST')
  .map(([u, i]) => ({ url: String(u), body: JSON.parse(String((i as RequestInit).body ?? '{}')) as Record<string, unknown> }));
const stateCalls = () => vi.mocked(apiFetch).mock.calls.filter(([u]) => String(u).includes('receipt-state'));

beforeEach(() => { vi.mocked(apiFetch).mockReset(); nav.flags = new Set(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('LOW-R2: the unsent list marks a payment crediting no cash account', () => {
  it('a refused one says "Not sent: no cash account"; one that could still be sent says nothing', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => envelope({ state: 'ok', sentence: null, items: [
      { allocationId: 'a-1', paymentId: 'p-1', paymentNumber: 'SP-1', paymentDate: '2026-09-01', billId: 'b-1', billNumber: 'B-1', amount: 10, partnerName: 'Velocity', refusal: null },
      { allocationId: 'a-2', paymentId: 'p-2', paymentNumber: 'SP-2', paymentDate: '2026-09-02', billId: 'b-2', billNumber: 'B-2', amount: 20, partnerName: 'Velocity', refusal: 'no_money_account' },
    ] }));
    render(<UnsentPaymentsSection />);
    const region = await screen.findByRole('region', { name: 'Paid with no payment message' });
    const [, first, second] = within(region).getAllByRole('row');
    expect(within(second!).getByText('Not sent: no cash account')).toBeInTheDocument();
    expect(within(first!).queryByText(/Not sent/)).toBeNull();
  });
});

describe('LOW-R3: the receipt chip of a stamped receipt, flag or not', () => {
  it('flag off, an F draft stamped IC:<id>: the chip says its word and its Discard posts the discard of that message', async () => {
    const changed = vi.fn();
    vi.mocked(apiFetch).mockImplementation(async (_url: unknown, init?: unknown) => (
      (init as RequestInit | undefined)?.method === 'POST' ? envelope({ messageId: MSG, status: 'pending', paymentId: 'r-5' })
        : envelope({ messageId: MSG, state: 'not_enabled', status: 'accepted' })));
    render(<ReceiptIcChip receiptId="r-5" paymentNumber="RC-5" bankReference={`IC:${MSG}`} paymentMethod="eft" receiptStatus="draft" onChanged={changed} />);
    expect(await screen.findByText('Intercompany: not enabled')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Discard draft RC-5' }));
    expect(await screen.findByText(/the payment message is open again/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'flag is off' } });
    fireEvent.click(screen.getByRole('button', { name: 'Discard the draft' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]).toEqual({ url: `/api/accounting/intercompany/payments/${MSG}/discard-draft`, body: { paymentId: 'r-5', reason: 'flag is off' } });
    await waitFor(() => expect(changed).toHaveBeenCalled());
  });

  it('flag off, an orphan F draft: the chip and its Discard still show', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => envelope({ messageId: MSG, state: 'not_found', status: 'orphan' }));
    render(<ReceiptIcChip receiptId="r-6" paymentNumber="RC-6" bankReference={`IC:${MSG}`} paymentMethod="eft" receiptStatus="draft" />);
    expect(await screen.findByText('Intercompany: its message is missing')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Discard draft RC-6' })).toBeInTheDocument();
  });

  it('a confirmed stamped receipt shows the chip but no Discard (only a draft is discarded)', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => envelope({ messageId: MSG, state: 'target_ok', status: 'accepted' }));
    render(<ReceiptIcChip receiptId="r-7" paymentNumber="RC-7" bankReference={`IC:${MSG}`} paymentMethod="eft" receiptStatus="confirmed" />);
    expect(await screen.findByText('Intercompany: matched')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Discard/ })).toBeNull();
  });

  it.each([
    ['no stamp', { bankReference: 'EFT 123', paymentMethod: 'eft' }],
    ['a stamped CONTRA receipt (P4-D, never an F draft)', { bankReference: `IC:${MSG}`, paymentMethod: 'contra' }],
    ['a stamp that is not a uuid', { bankReference: 'IC:not-a-uuid', paymentMethod: 'eft' }],
  ] as const)('flag off, %s: it asks nothing', async (_name, props) => {
    vi.mocked(apiFetch).mockImplementation(async () => envelope({ messageId: MSG, state: 'target_ok', status: 'accepted' }));
    const { container } = render(<ReceiptIcChip receiptId="r-8" paymentNumber="RC-8" receiptStatus="draft" {...props} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(stateCalls()).toHaveLength(0);
    expect(container.textContent).toBe('');
  });

  it('flag on, no stamp: it asks (an existing receipt matched by a message carries no stamp)', async () => {
    nav.flags = new Set(['intercompany_loan_clearing']);
    vi.mocked(apiFetch).mockImplementation(async () => envelope({ messageId: MSG, state: 'target_ok', status: 'accepted' }));
    render(<ReceiptIcChip receiptId="r-9" paymentNumber="RC-9" bankReference="EFT 9" paymentMethod="eft" receiptStatus="confirmed" />);
    expect(await screen.findByText('Intercompany: matched')).toBeInTheDocument();
    expect(stateCalls()).toHaveLength(1);
  });
});
