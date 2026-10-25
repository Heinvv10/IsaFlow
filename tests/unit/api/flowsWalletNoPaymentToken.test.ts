/**
 * S-07e: GET /api/billing/flows/wallet never carries a payment method token:
 * no app role may read flow_wallet.payment_method_token (migration 945), and
 * the page has nothing to do with it (v1 has no payment gateway).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/auth', async (orig) => ({ ...(await orig<typeof import('@/lib/auth')>()), withAuth: (x: unknown) => x }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (x: unknown) => x }));
vi.mock('@/lib/billing/getCompanyPlan', () => ({ getCompanyPlan: vi.fn(async () => ({ planCode: 'payg' })) }));
vi.mock('@/modules/billing/services/flowWalletService', () => ({ getWallet: vi.fn() }));

import { getWallet } from '@/modules/billing/services/flowWalletService';
import wallet from '../../../pages/api/billing/flows/wallet';

type H = (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>;

async function get() {
  const res = {
    statusCode: 200, body: undefined as { data?: Record<string, unknown> } | undefined,
    setHeader: vi.fn(), end: vi.fn(), send: vi.fn(),
    status(c: number) { res.statusCode = c; return res; },
    json(b: typeof res.body) { res.body = b; return res; },
  };
  await (wallet as unknown as H)({ method: 'GET', companyId: 'co-1' } as unknown as NextApiRequest, res as unknown as NextApiResponse);
  return res;
}

beforeEach(() => { vi.clearAllMocks(); });

describe('GET /api/billing/flows/wallet', () => {
  it('answers a company with no wallet row with a zero wallet and no token field', async () => {
    vi.mocked(getWallet).mockResolvedValueOnce(null);
    const res = await get();
    expect(res.statusCode).toBe(200);
    expect(res.body?.data).toMatchObject({ companyId: 'co-1', balance: 0, autoTopupEnabled: false, nudgeLevel: 'none' });
    expect(res.body?.data).not.toHaveProperty('paymentMethodToken');
  });

  it('passes the wallet through exactly as the service returned it', async () => {
    const w = { companyId: 'co-1', balance: 7, autoTopupEnabled: true, autoTopupBundleId: 'b', nudgeLevel: 'yellow',
      monthFlowsUsed: 1800, monthResetAt: new Date('2026-10-01') };
    vi.mocked(getWallet).mockResolvedValueOnce(w as never);
    const res = await get();
    expect(res.body?.data).toEqual(w);
  });
});
