/**
 * Budgets P5-1 routes, driven for real with the services mocked: POST /budgets/remaining (write
 * roles, CSRF, body shape, the user's bucket, company from the session, registry refusals as 4xx),
 * GET /notifications and POST /notifications/read (any member; CSRF on the write; the session's
 * company and user, never the body's).
 *
 * Mutation check: drop withCsrf or withWriteAccess, read companyId or userId from the body, or
 * accept { ids: [] }, and the matching test goes red.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const svc = vi.hoisted(() => ({ remaining: vi.fn(), list: vi.fn(), read: vi.fn(), rateLimit: vi.fn() }));

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/rateLimit', () => ({ checkRateLimit: (...a: unknown[]) => svc.rateLimit(...a) }));
// withAuth needs a database and a session: stubbed. withCsrf and withWriteAccess are the real wrappers.
vi.mock('@/lib/auth', async () => ({
  withAuth: (h: unknown) => h,
  withWriteAccess: (await vi.importActual<typeof import('@/lib/auth/withWriteAccess')>('@/lib/auth/withWriteAccess')).withWriteAccess,
}));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/modules/accounting/services/budgets/remainingBudget', () => ({ remainingFor: svc.remaining }));
vi.mock('@/modules/accounting/services/notifications/userNotificationService', () => ({
  listNotifications: svc.list, markRead: svc.read, MAX_MARK_READ_IDS: 100,
}));

import remainingRoute from '../../../pages/api/accounting/budgets/remaining';
import feedRoute from '../../../pages/api/accounting/notifications';
import readRoute from '../../../pages/api/accounting/notifications/read';
import { TrackingError } from '@/modules/accounting/services/budgets/tracking/trackingTypes';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const FOREIGN = '22222222-2222-4222-8222-222222222222';
const ACCT = '33333333-3333-4333-8333-333333333333';
const CSRF = 'c'.repeat(48);
type Route = (a: NextApiRequest, b: NextApiResponse) => Promise<unknown>;

async function call(route: unknown, over: Record<string, unknown>) {
  const req = {
    method: 'POST', query: {}, body: undefined, cookies: { isaflow_csrf: CSRF }, headers: { 'x-csrf-token': CSRF },
    companyId: COMPANY, companyRole: 'manager', user: { id: 'user-1', claims: {} }, ...over,
  } as unknown as NextApiRequest;
  const res = {
    statusCode: 0, sent: undefined as unknown, headers: {} as Record<string, string>,
    setHeader(name: string, value: string) { this.headers[name] = value; return this; },
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.sent = payload; return this; },
    end() { return this; },
  };
  await (route as Route)(req, res as unknown as NextApiResponse);
  return res as typeof res & { sent: { data?: unknown; error?: { code?: string; message?: string } } };
}

const line = { glAccountId: ACCT, month: '2026-04' };

beforeEach(() => {
  for (const f of Object.values(svc)) f.mockReset();
  svc.rateLimit.mockResolvedValue(true);
  svc.remaining.mockResolvedValue([{ budget: 10 }]);
  svc.list.mockResolvedValue({ items: [], unread: 0 });
  svc.read.mockResolvedValue({ updated: 1 });
});

describe('POST /api/accounting/budgets/remaining', () => {
  it('answers the preview for the session company, ids defaulted to null', async () => {
    const r = await call(remainingRoute, { body: { lines: [line], excludeInvoiceId: ACCT, companyId: FOREIGN } });
    expect(r.statusCode).toBe(200);
    expect(r.sent.data).toEqual({ lines: [{ budget: 10 }] });
    expect(svc.remaining).toHaveBeenCalledWith(COMPANY, [{ ...line, cc1Id: null, cc2Id: null, buId: null }],
      { excludeInvoiceId: ACCT, excludePoItemIds: undefined });
    expect(svc.rateLimit).toHaveBeenCalledWith('budget-remaining:user-1', { max: 120, windowSecs: 60 });
  });

  it('refuses GET (405), a missing CSRF token (403) and a viewer (403), reaching no service', async () => {
    expect((await call(remainingRoute, { method: 'GET' })).statusCode).toBe(405);
    expect((await call(remainingRoute, { body: { lines: [line] }, headers: {} })).statusCode).toBe(403);
    expect((await call(remainingRoute, { body: { lines: [line] }, companyRole: 'viewer' })).statusCode).toBe(403);
    expect(svc.remaining).not.toHaveBeenCalled();
  });

  it('422 for a bad month, a bad id, no lines or more than 200', async () => {
    for (const body of [{ lines: [{ ...line, month: '2026-13' }] }, { lines: [{ ...line, month: '2026-04-01' }] },
      { lines: [{ ...line, glAccountId: 'x' }] }, { lines: [] }, { lines: Array.from({ length: 201 }, () => line) }]) {
      expect((await call(remainingRoute, { body })).statusCode).toBe(422);
    }
    expect(svc.remaining).not.toHaveBeenCalled();
  });

  it('429 past the bucket; a registry refusal is its 4xx, not a 500', async () => {
    svc.rateLimit.mockResolvedValueOnce(false);
    const limited = await call(remainingRoute, { body: { lines: [line] } });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['Retry-After']).toBe('60');
    svc.remaining.mockRejectedValueOnce(new TrackingError(400, 'No financial year can be placed for that date'));
    expect((await call(remainingRoute, { body: { lines: [line] } })).statusCode).toBe(400);
  });
});

describe('notifications routes', () => {
  it('GET feed: the session company and user, any member', async () => {
    const r = await call(feedRoute, { method: 'GET', companyRole: 'viewer', query: { userId: 'someone-else' } });
    expect(r.statusCode).toBe(200);
    expect(svc.list).toHaveBeenCalledWith(COMPANY, 'user-1');
    expect((await call(feedRoute, { method: 'POST' })).statusCode).toBe(405);
  });

  it('POST read: by ids or all, the session\'s user (a viewer too); CSRF required', async () => {
    expect((await call(readRoute, { body: { ids: [ACCT] }, companyRole: 'viewer' })).statusCode).toBe(200);
    expect(svc.read).toHaveBeenLastCalledWith(COMPANY, 'user-1', { ids: [ACCT] });
    expect((await call(readRoute, { body: { all: true } })).statusCode).toBe(200);
    expect(svc.read).toHaveBeenLastCalledWith(COMPANY, 'user-1', { all: true });
    svc.read.mockClear();
    expect((await call(readRoute, { body: { all: true }, headers: {} })).statusCode).toBe(403);
    for (const body of [{}, { ids: [] }, { all: false }, { ids: ['x'] }, { ids: [ACCT], all: true }, { ids: [ACCT], userId: 'u2' },
      { ids: Array.from({ length: 101 }, () => ACCT) }]) {
      expect((await call(readRoute, { body })).statusCode).toBe(422);
    }
    expect(svc.read).not.toHaveBeenCalled();
    expect((await call(readRoute, { method: 'GET' })).statusCode).toBe(405);
  });
});
