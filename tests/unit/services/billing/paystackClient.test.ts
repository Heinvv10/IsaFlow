/**
 * Unit tests for the Paystack REST client.
 * Covers: initializeTransaction, verifyTransaction, chargeAuthorization,
 * createPlan, createSubscription, disableSubscription. Auth header,
 * request body shape, response unwrapping, status mapping, and error path.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

beforeEach(() => {
  process.env.PAYSTACK_SECRET_KEY = 'sk_test_abc123';
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

const mockFetchOk = (data: unknown) => ({
  ok: true,
  text: async () => JSON.stringify({ status: true, message: 'OK', data }),
});

const mockFetchErr = (status: number, body: unknown) => ({
  ok: false,
  status,
  text: async () => JSON.stringify(body),
});

describe('paystackClient — REST surface', () => {
  it('initializeTransaction posts JSON with Bearer auth and unwraps data', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      mockFetchOk({
        authorization_url: 'https://checkout.paystack.com/abc',
        access_code: 'ac_xyz',
        reference: 'ref_1',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { initializeTransaction } = await import('@/modules/billing/services/paystackClient');
    const result = await initializeTransaction({
      email: 'a@b.co.za',
      amountCents: 150000,
      reference: 'ref_1',
      callbackUrl: 'https://app.isaflow.co.za/portal/payments/paystack/return',
      metadata: { invoice_id: 'inv-1' },
    });

    expect(result).toEqual({
      authorizationUrl: 'https://checkout.paystack.com/abc',
      accessCode: 'ac_xyz',
      reference: 'ref_1',
    });

    const [url, init] = fetchMock.mock.calls[0]! as [string, { headers: Record<string, string>; body: string; method: string }];
    expect(url).toBe('https://api.paystack.co/transaction/initialize');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer sk_test_abc123');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body)).toMatchObject({
      email: 'a@b.co.za',
      amount: 150000,
      reference: 'ref_1',
      currency: 'ZAR',
      callback_url: 'https://app.isaflow.co.za/portal/payments/paystack/return',
      metadata: { invoice_id: 'inv-1' },
    });
  });

  it('verifyTransaction maps statuses + extracts authorization', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      mockFetchOk({
        status: 'success',
        reference: 'ref_2',
        id: 9876,
        amount: 250000,
        currency: 'ZAR',
        channel: 'card',
        paid_at: '2026-05-01T10:00:00Z',
        gateway_response: 'Approved',
        customer: { email: 'c@d.co.za', customer_code: 'CUS_1' },
        authorization: {
          authorization_code: 'AUTH_xyz',
          bin: '424242',
          last4: '4242',
          exp_month: '12',
          exp_year: '2030',
          card_type: 'visa',
          bank: 'TEST BANK',
          brand: 'visa',
          reusable: true,
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { verifyTransaction } = await import('@/modules/billing/services/paystackClient');
    const result = await verifyTransaction('ref_2');

    expect(result.status).toBe('success');
    expect(result.amountCents).toBe(250000);
    expect(result.authorization?.authorizationCode).toBe('AUTH_xyz');
    expect(result.authorization?.last4).toBe('4242');
    expect(result.authorization?.reusable).toBe(true);
    expect(result.customer?.customerCode).toBe('CUS_1');

    const [url, init] = fetchMock.mock.calls[0]! as [string, { method: string }];
    expect(url).toBe('https://api.paystack.co/transaction/verify/ref_2');
    expect(init.method).toBe('GET');
  });

  it.each([
    ['success', 'success'],
    ['failed', 'failed'],
    ['abandoned', 'abandoned'],
    ['reversed', 'reversed'],
    ['pending', 'pending'],
    ['anything_else', 'pending'],
  ] as const)('verifyTransaction maps "%s" → "%s"', async (raw, expected) => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      mockFetchOk({
        status: raw, reference: 'r', id: 1, amount: 1, currency: 'ZAR',
        channel: null, paid_at: null, gateway_response: null,
        customer: null, authorization: null,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { verifyTransaction } = await import('@/modules/billing/services/paystackClient');
    const result = await verifyTransaction('r');
    expect(result.status).toBe(expected);
  });

  it('chargeAuthorization sends authorization_code + email + amount', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      mockFetchOk({
        status: 'success',
        reference: 'sub_ref',
        id: 1234,
        amount: 50000,
        gateway_response: 'Successful',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { chargeAuthorization } = await import('@/modules/billing/services/paystackClient');
    const result = await chargeAuthorization({
      authorizationCode: 'AUTH_xyz',
      email: 'a@b.co.za',
      amountCents: 50000,
      reference: 'sub_ref',
    });

    expect(result.status).toBe('success');
    expect(result.reference).toBe('sub_ref');
    expect(result.paystackId).toBe(1234);

    const [url, init] = fetchMock.mock.calls[0]! as [string, { body: string }];
    expect(url).toBe('https://api.paystack.co/transaction/charge_authorization');
    expect(JSON.parse(init.body)).toMatchObject({
      authorization_code: 'AUTH_xyz',
      email: 'a@b.co.za',
      amount: 50000,
      reference: 'sub_ref',
      currency: 'ZAR',
    });
  });

  it('createPlan returns plan_code as planCode', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      mockFetchOk({
        id: 1,
        plan_code: 'PLN_test',
        name: 'Pro',
        amount: 49900,
        interval: 'monthly',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { createPlan } = await import('@/modules/billing/services/paystackClient');
    const result = await createPlan({
      name: 'Pro',
      amountCents: 49900,
      interval: 'monthly',
    });
    expect(result.planCode).toBe('PLN_test');
  });

  it('createSubscription posts customer + plan + authorization', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      mockFetchOk({
        id: 9,
        subscription_code: 'SUB_v',
        email_token: 'tok',
        status: 'active',
        amount: 49900,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { createSubscription } = await import('@/modules/billing/services/paystackClient');
    const result = await createSubscription({
      customer: 'a@b.co.za',
      planCode: 'PLN_test',
      authorizationCode: 'AUTH_xyz',
    });
    expect(result.subscriptionCode).toBe('SUB_v');
    expect(result.emailToken).toBe('tok');

    const [, init] = fetchMock.mock.calls[0]! as [string, { body: string }];
    expect(JSON.parse(init.body)).toEqual({
      customer: 'a@b.co.za',
      plan: 'PLN_test',
      authorization: 'AUTH_xyz',
    });
  });

  it('disableSubscription posts code + token', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      mockFetchOk({ ok: true }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { disableSubscription } = await import('@/modules/billing/services/paystackClient');
    await disableSubscription({ subscriptionCode: 'SUB_v', emailToken: 'tok' });

    const [, init] = fetchMock.mock.calls[0]! as [string, { body: string }];
    expect(JSON.parse(init.body)).toEqual({ code: 'SUB_v', token: 'tok' });
  });

  it('throws with server-supplied message on 4xx', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      mockFetchErr(400, { status: false, message: 'Invalid amount' }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { initializeTransaction } = await import('@/modules/billing/services/paystackClient');
    await expect(
      initializeTransaction({
        email: 'a@b.co.za',
        amountCents: -1,
        reference: 'r',
      }),
    ).rejects.toThrow(/Invalid amount/);
  });

  it('throws when PAYSTACK_SECRET_KEY is missing', async () => {
    delete process.env.PAYSTACK_SECRET_KEY;
    const { initializeTransaction } = await import('@/modules/billing/services/paystackClient');
    await expect(
      initializeTransaction({
        email: 'a@b.co.za',
        amountCents: 100,
        reference: 'r',
      }),
    ).rejects.toThrow(/PAYSTACK_SECRET_KEY/);
  });
});
