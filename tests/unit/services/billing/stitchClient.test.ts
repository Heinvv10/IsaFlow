/**
 * Unit tests for the Stitch Express REST client.
 * Stitch Express (vetting tier) only supports once-off payment links;
 * recurring / card-consent endpoints throw until the tenant is upgraded.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

beforeEach(async () => {
  process.env.STITCH_CLIENT_ID = 'test-client-123';
  process.env.STITCH_CLIENT_SECRET = 'test-secret-abc';
  const { __resetTokenCacheForTests } = await import('@/modules/billing/services/stitchClient');
  __resetTokenCacheForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('stitchClient — Stitch Express REST', () => {
  it('createPaymentLink — JSON token + JSON link request, unwraps {data: {payment}}', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, data: { accessToken: 'tok-1' } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({
          success: true,
          data: {
            payment: {
              id: 'pl_abc',
              link: 'https://express.stitch.money/pay/pl_abc',
              status: 'PENDING',
              amount: 150000,
              merchantReference: 'INV-001',
              payerName: 'Acme',
              paidAt: null,
              expireAt: '2026-05-23T00:00:00Z',
            },
          },
        }),
      });
    vi.stubGlobal('fetch', fetchMock);

    const { createPaymentLink } = await import('@/modules/billing/services/stitchClient');
    const result = await createPaymentLink({
      amountCents: 150000,
      payerName: 'Acme',
      merchantReference: 'INV-001',
      externalReference: 'ext-ref-1',
      redirectUrl: 'https://app.isaflow.co.za/portal/payments/stitch/return',
      description: 'Invoice INV-001',
    });

    expect(result).toEqual({
      id: 'pl_abc',
      url: 'https://express.stitch.money/pay/pl_abc',
      status: 'PENDING',
    });

    const tokenCall = fetchMock.mock.calls[0]!;
    expect(tokenCall[0]).toBe('https://express.stitch.money/api/v1/token');
    const tokenInit = tokenCall[1] as { headers: Record<string, string>; body: string };
    expect(tokenInit.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(tokenInit.body)).toEqual({
      clientId: 'test-client-123',
      clientSecret: 'test-secret-abc',
    });

    const linkCall = fetchMock.mock.calls[1]!;
    expect(linkCall[0]).toBe('https://express.stitch.money/api/v1/payment-links');
    const linkInit = linkCall[1] as { headers: Record<string, string>; body: string };
    expect(linkInit.headers.Authorization).toBe('Bearer tok-1');
    const linkBody = JSON.parse(linkInit.body) as Record<string, unknown>;
    expect(linkBody).toMatchObject({
      amount: 150000,
      currency: 'ZAR',
      payerName: 'Acme',
      merchantReference: 'INV-001',
      externalReference: 'ext-ref-1',
      redirectUrl: 'https://app.isaflow.co.za/portal/payments/stitch/return',
    });
  });

  it('reuses cached token within expiry window', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, data: { accessToken: 'tok-cached' } }),
      })
      .mockResolvedValue({
        ok: true,
        text: async () => JSON.stringify({
          success: true,
          data: { payment: { id: 'p', link: '', status: 'PAID', amount: 100, merchantReference: 'r', payerName: 'p', paidAt: null, expireAt: '' } },
        }),
      });
    vi.stubGlobal('fetch', fetchMock);

    const { getPaymentStatus } = await import('@/modules/billing/services/stitchClient');
    await getPaymentStatus('p1');
    await getPaymentStatus('p2');
    await getPaymentStatus('p3');

    const tokenCalls = fetchMock.mock.calls.filter(
      (c) => (c[0] as string) === 'https://express.stitch.money/api/v1/token',
    );
    expect(tokenCalls).toHaveLength(1);
  });

  it('getPaymentStatus maps Stitch uppercase status strings', async () => {
    const cases = [
      ['PAID', 'paid'],
      ['COMPLETED', 'paid'],
      ['SETTLED', 'settled'],
      ['FAILED', 'failed'],
      ['CANCELLED', 'cancelled'],
      ['EXPIRED', 'expired'],
      ['PENDING', 'pending'],
      ['SOMETHING_WEIRD', 'pending'],
    ] as const;

    for (const [raw, expected] of cases) {
      vi.resetModules();
      const fetchMock = vi.fn()
        .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, data: { accessToken: 't' } }) })
        .mockResolvedValueOnce({
          ok: true,
          text: async () => JSON.stringify({
            success: true,
            data: { payment: { id: 'x', link: '', status: raw, amount: 1, merchantReference: 'r', payerName: 'p', paidAt: null, expireAt: '' } },
          }),
        });
      vi.stubGlobal('fetch', fetchMock);
      const { getPaymentStatus, __resetTokenCacheForTests } = await import('@/modules/billing/services/stitchClient');
      __resetTokenCacheForTests();
      const res = await getPaymentStatus('pir');
      expect(res.status).toBe(expected);
    }
  });

  it('debitFromMandate throws with a clear "not enabled" message', async () => {
    const { debitFromMandate } = await import('@/modules/billing/services/stitchClient');
    await expect(
      debitFromMandate({
        bankAccountId: 'ba-1',
        amountCents: 1000,
        payerReference: 'r',
        beneficiaryReference: 'r',
        externalReference: 'e',
      }),
    ).rejects.toThrow(/not enabled on this tenant/);
  });

  it('throws with server-supplied message on 4xx', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, data: { accessToken: 't' } }) })
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ message: 'amount must be positive' }),
      });
    vi.stubGlobal('fetch', fetchMock);

    const { createPaymentLink, __resetTokenCacheForTests } = await import('@/modules/billing/services/stitchClient');
    __resetTokenCacheForTests();
    await expect(
      createPaymentLink({
        amountCents: 1000,
        payerName: 'Tester',
        merchantReference: 'r',
        externalReference: 'e',
        redirectUrl: 'https://example.com',
      }),
    ).rejects.toThrow(/amount must be positive/);
  });
});
