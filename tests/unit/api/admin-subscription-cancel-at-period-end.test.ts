/**
 * K-034 L-c: PATCH /api/admin/billing/subscriptions/[id] is the only thing
 * standing between the company billing tab and a 400 — its body schema is
 * .strict(), and the tab sends { cancel_at_period_end: true }. These cases pin
 * the route contract; the behaviour behind it is covered by the K-034
 * integration suite.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiResponse } from 'next';
import type { AuthenticatedNextApiRequest } from '@/lib/auth';

const { cancelSubscriptionMock, updateSubscriptionMock, getSubscriptionMock, logAdminActionMock } =
  vi.hoisted(() => ({
    cancelSubscriptionMock: vi.fn(),
    updateSubscriptionMock: vi.fn(),
    getSubscriptionMock: vi.fn(),
    logAdminActionMock: vi.fn(),
  }));

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/modules/admin/services/billingService', () => ({
  cancelSubscription: cancelSubscriptionMock,
  updateSubscription: updateSubscriptionMock,
  getSubscription: getSubscriptionMock,
}));
vi.mock('@/modules/admin/services/auditService', () => ({ logAdminAction: logAdminActionMock }));
vi.mock('@/utils/getIp', () => ({ getIp: vi.fn(() => '127.0.0.1') }));
// Identity wrappers — auth and CSRF have their own tests.
vi.mock('@/modules/admin/middleware/withAdmin', () => ({ withAdmin: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));

import handler from '../../../pages/api/admin/billing/subscriptions/[id]';

const SUBSCRIPTION_ID = '11111111-1111-4111-8111-111111111111';

function makeRes() {
  const res: Partial<NextApiResponse> & { statusCode?: number; body?: unknown } = {};
  res.status = vi.fn((code: number) => {
    res.statusCode = code;
    return res as NextApiResponse;
  }) as unknown as NextApiResponse['status'];
  res.json = vi.fn((body: unknown) => {
    res.body = body;
    return res as NextApiResponse;
  }) as unknown as NextApiResponse['json'];
  return res as NextApiResponse & { statusCode?: number; body?: unknown };
}

function makeReq(body: unknown): AuthenticatedNextApiRequest {
  return {
    method: 'PATCH',
    query: { id: SUBSCRIPTION_ID },
    body,
    user: { id: 'admin-1' },
  } as unknown as AuthenticatedNextApiRequest;
}

async function call(body: unknown) {
  const req = makeReq(body);
  const res = makeRes();
  await (handler as unknown as (r: typeof req, s: typeof res) => Promise<void>)(req, res);
  return res;
}

describe('PATCH /api/admin/billing/subscriptions/[id]', () => {
  beforeEach(() => vi.clearAllMocks());

  it('schedules the cancellation the company billing tab asks for', async () => {
    const res = await call({ cancel_at_period_end: true });

    expect(res.statusCode).toBe(200);
    expect(cancelSubscriptionMock).toHaveBeenCalledWith(SUBSCRIPTION_ID, true);
    expect(updateSubscriptionMock).not.toHaveBeenCalled();
  });

  it('rejects cancel_at_period_end: false rather than cancelling immediately', async () => {
    const res = await call({ cancel_at_period_end: false });

    expect(res.statusCode).toBe(400);
    expect(cancelSubscriptionMock).not.toHaveBeenCalled();
  });

  it('still routes ordinary field edits to updateSubscription', async () => {
    const res = await call({ notes: 'moved to annual next cycle' });

    expect(res.statusCode).toBe(200);
    expect(updateSubscriptionMock).toHaveBeenCalledWith(SUBSCRIPTION_ID, {
      notes: 'moved to annual next cycle',
    });
    expect(cancelSubscriptionMock).not.toHaveBeenCalled();
  });

  it('rejects a key the schema does not know', async () => {
    const res = await call({ cancelled_at: '2026-09-09' });

    expect(res.statusCode).toBe(400);
    expect(updateSubscriptionMock).not.toHaveBeenCalled();
  });
});
