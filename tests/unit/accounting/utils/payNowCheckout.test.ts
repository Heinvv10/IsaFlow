/**
 * R-177: the staff Pay Now button asks pay-now for the invoice's standing link, then starts the
 * checkout from it through the public create route. Runs the REAL assertOk over scripted responses.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useApiJsonOverMock } from '../../helpers/apiJsonOverMock';

vi.mock('@/lib/apiFetch', async () => (await import('../../helpers/apiJsonOverMock')).mockedApiFetchModule());
import { apiFetch } from '@/lib/apiFetch';
import { startPayNowCheckout } from '@/modules/accounting/utils/payNowCheckout';

useApiJsonOverMock();
const respond = (status: number, body: unknown) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
const script = (link: Response, create?: Response) => vi.mocked(apiFetch).mockImplementation(async (url: unknown) =>
  (String(url).includes('/pay-now') ? link : (create ?? respond(500, ''))));
const PLAIN = 'Could not start the payment - try again';

beforeEach(() => { vi.mocked(apiFetch).mockReset(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('startPayNowCheckout', () => {
  it('posts to pay-now, then starts the checkout with the token it was given', async () => {
    script(respond(200, { success: true, data: { token: 'tok_1' } }), respond(200, { success: true, data: { checkoutUrl: 'https://checkout.test/abc' } }));
    await expect(startPayNowCheckout('inv-1')).resolves.toBe('https://checkout.test/abc');
    expect(apiFetch).toHaveBeenCalledWith('/api/accounting/customer-invoices/inv-1/pay-now', expect.objectContaining({ method: 'POST' }));
    expect(apiFetch).toHaveBeenCalledWith('/api/portal/payments/paystack/create', expect.objectContaining({ body: JSON.stringify({ token: 'tok_1' }) }));
  });

  it('a refusal from pay-now is thrown with its message and no checkout is started', async () => {
    script(respond(400, { success: false, error: { code: 'X', message: 'A draft invoice cannot be paid online. Approve it first.' } }));
    await expect(startPayNowCheckout('inv-1')).rejects.toThrow('A draft invoice cannot be paid online. Approve it first.');
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it('an empty-body 500 from pay-now is a plain sentence, never a JSON parse error', async () => {
    script(respond(500, ''));
    await expect(startPayNowCheckout('inv-1')).rejects.toThrow(PLAIN);
  });

  it('a 200 from pay-now with no token (or an empty body) starts no checkout', async () => {
    script(respond(200, { success: true, data: {} }));
    await expect(startPayNowCheckout('inv-1')).rejects.toThrow(PLAIN);
    script(respond(200, ''));
    await expect(startPayNowCheckout('inv-1')).rejects.toThrow(PLAIN);
    expect(vi.mocked(apiFetch).mock.calls.every(([u]) => String(u).includes('/pay-now'))).toBe(true);
  });

  it('a refusal from create (409 while a checkout is starting) is thrown with its message', async () => {
    script(respond(200, { data: { token: 'tok_1' } }), respond(409, { error: { message: 'Your payment is being set up. Please retry in a moment.' } }));
    await expect(startPayNowCheckout('inv-1')).rejects.toThrow('Your payment is being set up. Please retry in a moment.');
  });

  it('an empty-body 500 from create, and a 200 with no checkout URL, are plain sentences', async () => {
    script(respond(200, { data: { token: 'tok_1' } }), respond(500, ''));
    await expect(startPayNowCheckout('inv-1')).rejects.toThrow(PLAIN);
    script(respond(200, { data: { token: 'tok_1' } }), respond(200, { data: {} }));
    await expect(startPayNowCheckout('inv-1')).rejects.toThrow(PLAIN);
  });
});
