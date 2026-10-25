/**
 * Flow bundle purchase and auto top-up were open to every company member: a viewer could start a paid
 * Flow checkout (POST /api/billing/flows/purchase) or switch auto top-up (PATCH /api/billing/flows/auto-topup).
 * Both are now owner/admin only, like the Paystack mandate routes. A refused role gets 403 before any
 * query, Paystack call or wallet write; owner and admin reach the handler body.
 * Only the auth wrappers, the DB and the billing services are mocked; withWriteAccess is the real one.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => [{ name: 'Acme' }]) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', async (orig) => ({ ...(await orig<typeof import('@/lib/auth')>()), withAuth: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/lib/billing/getCompanyPlan', () => ({ getCompanyPlan: vi.fn(async () => ({ planCode: 'payg' })) }));
vi.mock('@/modules/billing/services/paystackClient', () => ({
  initializeTransaction: vi.fn(async () => ({ reference: 'ref-1', accessCode: 'ac-1', authorizationUrl: 'https://checkout.example/x' })),
}));
vi.mock('@/modules/billing/services/flowWalletService', () => ({
  startBundlePurchase: vi.fn(async () => ({ purchaseId: '44444444-4444-4444-8444-444444444444', bundle: { name: 'Small', flows: 100, priceCents: 9900 } })),
  completeBundlePurchase: vi.fn(),
  failBundlePurchase: vi.fn(),
  setAutoTopup: vi.fn(async () => undefined),
}));

import { sql } from '@/lib/neon';
import { getCompanyPlan } from '@/lib/billing/getCompanyPlan';
import { initializeTransaction } from '@/modules/billing/services/paystackClient';
import { startBundlePurchase, setAutoTopup } from '@/modules/billing/services/flowWalletService';
import purchase from '../../../pages/api/billing/flows/purchase';
import autoTopup from '../../../pages/api/billing/flows/auto-topup';

type H = (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>;
const BUNDLE = '22222222-2222-4222-8222-222222222222';
const REFUSED: Array<string | null | undefined> = ['manager', 'viewer', 'storeman', 'technician', 'system', 'super_admin', null, undefined];

function makeRes() {
  const res = {
    statusCode: 200, body: undefined as { error?: { message?: string } } | undefined,
    setHeader: vi.fn(), end: vi.fn(), send: vi.fn(),
    status(c: number) { res.statusCode = c; return res; },
    json(b: typeof res.body) { res.body = b; return res; },
  };
  return res;
}
function makeReq(method: string, companyRole: string | null | undefined, body: unknown): NextApiRequest {
  return {
    method, headers: {}, cookies: {}, query: {}, body,
    companyId: '11111111-1111-4111-8111-111111111111', companyRole, user: { id: 'u-1', email: 'u@example.com' },
  } as unknown as NextApiRequest;
}
async function call(h: unknown, method: string, role: string | null | undefined, body: unknown) {
  const res = makeRes();
  await (h as H)(makeReq(method, role, body), res as unknown as NextApiResponse);
  return res;
}
const refusedByGate = (res: ReturnType<typeof makeRes>) =>
  res.statusCode === 403 && /does not allow this action|no company role on request/.test(res.body?.error?.message ?? '');

let savedKey: string | undefined;
beforeEach(() => { vi.clearAllMocks(); savedKey = process.env.PAYSTACK_SECRET_KEY; process.env.PAYSTACK_SECRET_KEY = 'sk_test_unit'; });
afterEach(() => { if (savedKey === undefined) delete process.env.PAYSTACK_SECRET_KEY; else process.env.PAYSTACK_SECRET_KEY = savedKey; });

describe('POST /api/billing/flows/purchase — owner and admin only', () => {
  it.each(REFUSED)('role %s gets 403 before any query or Paystack call', async (role) => {
    const res = await call(purchase, 'POST', role, { bundleId: BUNDLE });
    expect(refusedByGate(res), `${res.statusCode} ${JSON.stringify(res.body)}`).toBe(true);
    expect(sql).not.toHaveBeenCalled();
    expect(getCompanyPlan).not.toHaveBeenCalled();
    expect(startBundlePurchase).not.toHaveBeenCalled();
    expect(initializeTransaction).not.toHaveBeenCalled();
  });

  it('a refused role gets 403, not 503, when no gateway is configured', async () => {
    delete process.env.PAYSTACK_SECRET_KEY;
    const res = await call(purchase, 'POST', 'viewer', { bundleId: BUNDLE });
    expect(refusedByGate(res)).toBe(true);
  });

  it.each(['owner', 'admin'])('%s reaches the Paystack checkout', async (role) => {
    const res = await call(purchase, 'POST', role, { bundleId: BUNDLE });
    expect(res.statusCode, JSON.stringify(res.body)).toBe(201);
    expect(initializeTransaction).toHaveBeenCalledTimes(1);
    expect(sql).toHaveBeenCalled();
  });
});

describe('PATCH /api/billing/flows/auto-topup — owner and admin only', () => {
  it.each(REFUSED)('role %s gets 403 before any query or wallet write', async (role) => {
    const res = await call(autoTopup, 'PATCH', role, { enabled: true, bundleId: BUNDLE });
    expect(refusedByGate(res), `${res.statusCode} ${JSON.stringify(res.body)}`).toBe(true);
    expect(sql).not.toHaveBeenCalled();
    expect(getCompanyPlan).not.toHaveBeenCalled();
    expect(setAutoTopup).not.toHaveBeenCalled();
  });

  // Switching off: since S-07e switching on is refused for every role (no payment method in v1).
  it.each(['owner', 'admin'])('%s reaches the update', async (role) => {
    const res = await call(autoTopup, 'PATCH', role, { enabled: false });
    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    expect(setAutoTopup).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111', false, null);
  });
});

describe('the GET passthrough reaches no write', () => {
  it.each([['purchase', purchase], ['auto-topup', autoTopup]] as const)('%s: a viewer GET is refused with 405', async (_n, h) => {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      const res = await call(h, method, 'viewer', { enabled: true, bundleId: BUNDLE });
      expect(res.statusCode).toBe(405);
    }
    expect(sql).not.toHaveBeenCalled();
    expect(getCompanyPlan).not.toHaveBeenCalled();
    expect(initializeTransaction).not.toHaveBeenCalled();
    expect(setAutoTopup).not.toHaveBeenCalled();
  });
});
