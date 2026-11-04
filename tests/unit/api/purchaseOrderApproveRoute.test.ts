/**
 * Budgets P5-3: POST /api/accounting/purchase-orders/[id]/approve, driven with the service mocked and the real
 * withCsrf / withWriteAccess: CSRF and write roles gate it before the service; the company, user and role come from
 * the session (never the body, which is strict); the service gets the UI channel taking the budget lock itself.
 * Mutation check: drop withCsrf or withWriteAccess, or pass the body's role, and a test goes red.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const svc = vi.hoisted(() => ({ approve: vi.fn(), rateLimit: vi.fn() }));

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/rateLimit', () => ({ checkRateLimit: (...a: unknown[]) => svc.rateLimit(...a) }));
vi.mock('@/lib/auth', async () => ({
  withAuth: (h: unknown) => h,
  withWriteAccess: (await vi.importActual<typeof import('@/lib/auth/withWriteAccess')>('@/lib/auth/withWriteAccess')).withWriteAccess,
}));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/modules/accounting/services/ap/purchaseOrderApprove', async () => ({
  ...(await vi.importActual<typeof import('@/modules/accounting/services/ap/purchaseOrderApprove')>('@/modules/accounting/services/ap/purchaseOrderApprove')),
  approvePurchaseOrder: svc.approve,
}));

import route from '../../../pages/api/accounting/purchase-orders/[id]/approve';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const PO = '22222222-2222-4222-8222-222222222222';
const CSRF = 'c'.repeat(48);

async function call(over: Record<string, unknown>) {
  const req = {
    method: 'POST', query: { id: PO }, body: {}, cookies: { isaflow_csrf: CSRF }, headers: { 'x-csrf-token': CSRF },
    companyId: COMPANY, companyRole: 'manager', user: { id: 'user-1', claims: {} }, ...over,
  } as unknown as NextApiRequest;
  const res = {
    statusCode: 0, sent: undefined as unknown, headers: {} as Record<string, string>,
    setHeader(name: string, value: string) { this.headers[name] = value; return this; },
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.sent = payload; return this; },
    end() { return this; },
  };
  await (route as unknown as (a: NextApiRequest, b: NextApiResponse) => Promise<unknown>)(req, res as unknown as NextApiResponse);
  return res;
}

beforeEach(() => {
  svc.approve.mockReset().mockResolvedValue({ purchaseOrder: { id: PO, status: 'approved' } });
  svc.rateLimit.mockReset().mockResolvedValue(true);
});

describe('POST /purchase-orders/[id]/approve', () => {
  it('without the CSRF token: 403, the service never runs', async () => {
    const r = await call({ headers: {} });
    expect(r.statusCode).toBe(403);
    expect(svc.approve).not.toHaveBeenCalled();
  });

  it('a viewer: 403, the service never runs', async () => {
    const r = await call({ companyRole: 'viewer' });
    expect(r.statusCode).toBe(403);
    expect(svc.approve).not.toHaveBeenCalled();
  });

  it('session company, user and role; UI channel taking the lock; the reason and override passed on', async () => {
    const r = await call({ body: { budgetReason: ' why ', budgetOverride: true } });
    expect(r.statusCode).toBe(200);
    expect(svc.approve).toHaveBeenCalledWith(COMPANY, PO, 'user-1', {
      channel: 'ui', lock: 'take', reason: 'why', override: true, actorRole: 'manager',
    });
    expect(svc.rateLimit).toHaveBeenCalledWith('purchase-order-approve:user-1', { max: 120, windowSecs: 60 });
  });

  it('a body naming a company or role is refused (strict, 422); GET is 405', async () => {
    expect((await call({ body: { companyId: COMPANY, actorRole: 'owner' } })).statusCode).toBe(422);
    expect((await call({ method: 'GET' })).statusCode).toBe(405);
    expect(svc.approve).not.toHaveBeenCalled();
  });

  it('rate limited: 429 with Retry-After, the service never runs', async () => {
    svc.rateLimit.mockResolvedValue(false);
    const r = await call({});
    expect(r.statusCode).toBe(429);
    expect(r.headers['Retry-After']).toBe('60');
    expect(svc.approve).not.toHaveBeenCalled();
  });
});
