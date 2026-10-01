/**
 * R-177: the staff Pay Now button asks pay-now for the invoice's standing link, then starts the
 * checkout from it through the public create route.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('@/lib/apiFetch', () => ({ apiFetch }));
import { startPayNowCheckout } from '@/modules/accounting/utils/payNowCheckout';

const answer = (ok: boolean, body: unknown) => ({ ok, json: async () => body });
const fetchMock = vi.fn();

beforeEach(() => { apiFetch.mockReset(); fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('startPayNowCheckout', () => {
  it('posts to pay-now, then starts the checkout with the token it was given', async () => {
    apiFetch.mockResolvedValue(answer(true, { data: { token: 'tok_1', paymentUrl: 'https://x/portal/pay/tok_1' } }));
    fetchMock.mockResolvedValue(answer(true, { data: { checkoutUrl: 'https://checkout.test/abc', reference: 'ref' } }));
    await expect(startPayNowCheckout('inv-1')).resolves.toBe('https://checkout.test/abc');
    expect(apiFetch).toHaveBeenCalledWith('/api/accounting/customer-invoices/inv-1/pay-now', expect.objectContaining({ method: 'POST' }));
    expect(fetchMock).toHaveBeenCalledWith('/api/portal/payments/paystack/create', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ token: 'tok_1' }),
    }));
  });

  it('a refusal from pay-now is thrown with its message and no checkout is started', async () => {
    apiFetch.mockResolvedValue(answer(false, { error: { message: 'A draft invoice cannot be paid online. Approve it first.' } }));
    await expect(startPayNowCheckout('inv-1')).rejects.toThrow('A draft invoice cannot be paid online. Approve it first.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a 200 from pay-now with no token starts no checkout', async () => {
    apiFetch.mockResolvedValue(answer(true, { data: {} }));
    await expect(startPayNowCheckout('inv-1')).rejects.toThrow('Failed to start payment');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a refusal from create (409 while a checkout is starting) is thrown with its message', async () => {
    apiFetch.mockResolvedValue(answer(true, { data: { token: 'tok_1' } }));
    fetchMock.mockResolvedValue(answer(false, { error: { message: 'Your payment is being set up. Please retry in a moment.' } }));
    await expect(startPayNowCheckout('inv-1')).rejects.toThrow('Your payment is being set up. Please retry in a moment.');
  });

  it('a 200 from create with no checkout URL is a failure, not an open tab on undefined', async () => {
    apiFetch.mockResolvedValue(answer(true, { data: { token: 'tok_1' } }));
    fetchMock.mockResolvedValue(answer(true, { data: {} }));
    await expect(startPayNowCheckout('inv-1')).rejects.toThrow('Failed to start payment');
  });
});
