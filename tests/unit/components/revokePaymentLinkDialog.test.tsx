// LINK-REVOKE: the dialog's call and its callbacks. onDone runs after every attempt (the page
// reloads the invoice), then onError carries the server's message, or a plain fallback sentence, on a failure, then onClose.
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('@/lib/apiFetch', async (original) => ({ ...await original<typeof import('@/lib/apiFetch')>(), apiFetch: vi.fn() }));

import { apiFetch } from '@/lib/apiFetch';
import { RevokePaymentLinkDialog } from '@/components/invoices/RevokePaymentLinkDialog';

afterEach(() => vi.mocked(apiFetch).mockReset());

function mount() {
  const calls: string[] = [];
  const onError = vi.fn((m: string) => { calls.push(`error:${m}`); });
  render(<RevokePaymentLinkDialog open invoiceId="inv-1" invoiceNumber="INV-9"
    onClose={() => calls.push('close')} onDone={() => calls.push('done')} onError={onError} />);
  return calls;
}
const reply = (status: number, message?: string) => new Response(
  JSON.stringify(status === 200 ? { success: true, data: { revoked: true, cancelled: 1 } } : { success: false, error: { message } }), { status });

it.each([
  ['an empty 502', () => new Response('', { status: 502 })],
  ['a dropped connection', () => { throw new TypeError('Failed to fetch'); }],
])('%s shows the plain fallback sentence, not the transport text', async (_n, answer) => {
  vi.mocked(apiFetch).mockImplementation(async () => answer());
  const calls = mount();
  fireEvent.click(screen.getByRole('button', { name: 'Revoke link' }));
  await vi.waitFor(() => expect(calls).toEqual(['done', 'error:Could not revoke the payment link - try again', 'close']));
});

it('names the cutoff with its timezone', () => {
  mount();
  expect(screen.getByText(/created after 07:00 SAST on 1 October 2026 are not affected/)).toBeTruthy();
});

it('posts to the revoke route; on success reloads and closes without an error', async () => {
  vi.mocked(apiFetch).mockResolvedValue(reply(200));
  const calls = mount();
  fireEvent.click(screen.getByRole('button', { name: 'Revoke link' }));
  await vi.waitFor(() => expect(calls).toEqual(['done', 'close']));
  expect(apiFetch).toHaveBeenCalledWith('/api/accounting/customer-invoices/inv-1/payment-link/revoke', { method: 'POST' });
});

it.each([[404, 'No active payment link'], [403, 'Forbidden: write access required']])(
  'a %s reloads first, then shows the server message, then closes', async (status, message) => {
    vi.mocked(apiFetch).mockResolvedValue(reply(status, message));
    const calls = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Revoke link' }));
    await vi.waitFor(() => expect(calls).toEqual(['done', `error:${message}`, 'close']));
  });
