/**
 * The reforecast route (Budgets P4 PR-4, `budget-versions/[id]/reforecast`), driven for real with
 * the services mocked: methods, the CSRF check and role gate (the REAL withCsrf and
 * withWriteAccess), body validation (create, Roll now and the toggle; the version token the last
 * two must carry), the user's write bucket (reads are not charged), the company and role taken
 * from the session never the body, 201 for a new reforecast, and each refusal's status and code:
 * 409 STALE with the current token, 409 LOCKED / STATE, 404 NOT_FOUND, 400 DRIVER_RANGE.
 *
 * Mutation check: drop withCsrf or withWriteAccess, read companyId from the body, answer the create
 * 200, or route { action: 'roll' } to the create, and the matching test goes red.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const svc = vi.hoisted(() => ({
  create: vi.fn(), roll: vi.fn(), status: vi.fn(), toggle: vi.fn(), rateLimit: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/rateLimit', () => ({ checkRateLimit: (...a: unknown[]) => svc.rateLimit(...a) }));
// withAuth needs a database and a session: stubbed. withCsrf and withWriteAccess are the real wrappers.
vi.mock('@/lib/auth', async () => ({
  withAuth: (h: unknown) => h,
  withWriteAccess: (await vi.importActual<typeof import('@/lib/auth/withWriteAccess')>('@/lib/auth/withWriteAccess')).withWriteAccess,
}));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/modules/accounting/services/budgets/drivers/reforecastService', () => ({ createReforecastFromActuals: svc.create }));
vi.mock('@/modules/accounting/services/budgets/drivers/rollingForecastService', () => ({ rollVersion: svc.roll, setRolling: svc.toggle }));
vi.mock('@/modules/accounting/services/budgets/drivers/rollingStatus', () => ({ rollingStatus: svc.status }));

import route from '../../../pages/api/accounting/budget-versions/[id]/reforecast';
import { DriverRangeError } from '@/modules/accounting/services/budgets/drivers/driverTypes';
import { BudgetVersionError } from '@/modules/accounting/services/budgets/budgetVersionTypes';
import { BudgetVersionStaleError } from '@/modules/accounting/services/budgets/versionTake';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const FOREIGN = '22222222-2222-4222-8222-222222222222';
const V = '33333333-3333-4333-8333-333333333333';
const CSRF = 'c'.repeat(48);
const T = '2026-10-29T07:17:00.307234Z';

async function call(over: Record<string, unknown>) {
  const req = {
    method: 'GET', query: { id: V }, body: undefined, cookies: { isaflow_csrf: CSRF }, headers: { 'x-csrf-token': CSRF },
    companyId: COMPANY, companyRole: 'manager', user: { id: 'user-1', claims: {} }, ...over,
  } as unknown as NextApiRequest;
  const res = {
    statusCode: 0, sent: undefined as unknown, headers: {} as Record<string, string>,
    setHeader(name: string, value: string) { this.headers[name] = value; return this; },
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.sent = payload; return this; },
    end() { return this; },
  };
  await (route as (a: NextApiRequest, b: NextApiResponse) => Promise<unknown>)(req, res as unknown as NextApiResponse);
  return res as typeof res & { sent: { data?: unknown; error?: { message?: string; details?: Record<string, unknown> } } };
}

beforeEach(() => {
  for (const f of Object.values(svc)) f.mockReset();
  svc.rateLimit.mockResolvedValue(true);
  svc.create.mockResolvedValue({ version: { id: 'new' }, unplaced: [] });
  svc.roll.mockResolvedValue({ status: 'rolled', changed: 0 });
  svc.status.mockResolvedValue({ rolling: false });
  svc.toggle.mockResolvedValue({ rolling: true, changed: true, updatedAt: T });
});

describe('reforecast route: methods, CSRF, roles and the bucket', () => {
  it('refuses DELETE and PATCH (405) and a bad version id (400)', async () => {
    expect((await call({ method: 'DELETE' })).statusCode).toBe(405);
    expect((await call({ method: 'PATCH' })).statusCode).toBe(405);
    expect((await call({ method: 'GET', query: { id: 'nope' } })).statusCode).toBe(400);
    expect(svc.status).not.toHaveBeenCalled();
  });

  it('a write without the CSRF token is 403 and reaches no service', async () => {
    const r = await call({ method: 'POST', body: { name: 'RF' }, headers: {} });
    expect(r.statusCode).toBe(403);
    expect(svc.create).not.toHaveBeenCalled();
  });

  it('a viewer may read the status but not create, roll or toggle', async () => {
    expect((await call({ method: 'GET', companyRole: 'viewer' })).statusCode).toBe(200);
    for (const [method, body] of [['POST', { name: 'RF' }], ['POST', { action: 'roll', expectedUpdatedAt: T }], ['PUT', { rolling: true, expectedUpdatedAt: T }]] as const) {
      expect((await call({ method, body, companyRole: 'viewer' })).statusCode).toBe(403);
    }
    expect(svc.create).not.toHaveBeenCalled();
    expect(svc.roll).not.toHaveBeenCalled();
    expect(svc.toggle).not.toHaveBeenCalled();
  });

  it('charges writes to the budget-reforecast bucket (30 a minute), the status GET to its own (120); 429 + Retry-After past either', async () => {
    await call({ method: 'GET' });
    expect(svc.rateLimit.mock.calls).toEqual([['budget-reforecast-status:user-1', { max: 120, windowSecs: 60 }]]);
    svc.rateLimit.mockResolvedValue(false);
    const read = await call({ method: 'GET' });
    expect([read.statusCode, read.headers['Retry-After']]).toEqual([429, '60']);
    expect(svc.status).toHaveBeenCalledTimes(1);
    svc.rateLimit.mockClear();
    const r = await call({ method: 'POST', body: { name: 'RF' } });
    expect([r.statusCode, r.headers['Retry-After']]).toEqual([429, '60']);
    expect(svc.rateLimit.mock.calls).toEqual([['budget-reforecast:user-1', { max: 30, windowSecs: 60 }]]);
    expect(svc.create).not.toHaveBeenCalled();
  });
});

describe('reforecast route: bodies', () => {
  it("creates (201) as the session's company and role, never the body's, rolling false by default", async () => {
    const r = await call({ method: 'POST', body: { name: 'Reforecast Q2' } });
    expect(r.statusCode).toBe(201);
    expect(svc.create).toHaveBeenCalledWith(COMPANY, { userId: 'user-1', role: 'manager' }, V, { name: 'Reforecast Q2', rolling: false });
    expect((await call({ method: 'POST', body: { name: 'RF', companyId: FOREIGN } })).statusCode).toBe(422);
    expect(svc.create).toHaveBeenCalledTimes(1);
  });

  it('Roll now and the toggle pass the token; GET passes the version', async () => {
    expect((await call({ method: 'POST', body: { action: 'roll', expectedUpdatedAt: T } })).statusCode).toBe(200);
    expect(svc.roll).toHaveBeenCalledWith(COMPANY, 'user-1', V, { expectedUpdatedAt: T });
    expect((await call({ method: 'PUT', body: { rolling: false, expectedUpdatedAt: T } })).statusCode).toBe(200);
    expect(svc.toggle).toHaveBeenCalledWith(COMPANY, 'user-1', V, false, T);
    expect((await call({ method: 'GET' })).sent.data).toEqual({ rolling: false });
    expect(svc.status).toHaveBeenCalledWith(COMPANY, V);
    expect(svc.create).not.toHaveBeenCalled();
  });

  it('refuses a bad create, roll or toggle body (422) and calls nothing', async () => {
    for (const body of [{}, { name: 5 }, { name: 'RF', rolling: 'yes' }]) {
      expect((await call({ method: 'POST', body })).statusCode, JSON.stringify(body)).toBe(422);
    }
    for (const body of [{ action: 'roll' }, { action: 'roll', expectedUpdatedAt: '2026-02-30T00:00:00Z' }, { action: 'unroll', expectedUpdatedAt: T }]) {
      expect((await call({ method: 'POST', body })).statusCode, JSON.stringify(body)).toBe(422);
    }
    for (const body of [{ rolling: true }, { rolling: 'on', expectedUpdatedAt: T }]) {
      expect((await call({ method: 'PUT', body })).statusCode, JSON.stringify(body)).toBe(422);
    }
    expect(svc.create).not.toHaveBeenCalled();
    expect(svc.roll).not.toHaveBeenCalled();
    expect(svc.toggle).not.toHaveBeenCalled();
  });
});

describe('reforecast route: refusals', () => {
  it('a stale token is 409 BUDGET_VERSION_STALE with the current token and status', async () => {
    svc.roll.mockRejectedValue(new BudgetVersionStaleError('2026-10-29T08:00:00.000001Z', 'draft'));
    const r = await call({ method: 'POST', body: { action: 'roll', expectedUpdatedAt: T } });
    expect([r.statusCode, r.sent.error?.details]).toEqual([409, { code: 'BUDGET_VERSION_STALE', currentUpdatedAt: '2026-10-29T08:00:00.000001Z', status: 'draft' }]);
  });

  it('locked and state are 409, not found 404, an actual beyond the range 400 DRIVER_RANGE', async () => {
    svc.roll.mockRejectedValueOnce(new BudgetVersionError('BUDGET_VERSION_LOCKED', 'This budget version is locked'));
    const locked = await call({ method: 'POST', body: { action: 'roll', expectedUpdatedAt: T } });
    expect([locked.statusCode, locked.sent.error?.details]).toEqual([409, { code: 'BUDGET_VERSION_LOCKED' }]);
    svc.create.mockRejectedValueOnce(new BudgetVersionError('BUDGET_VERSION_STATE', 'FY2027 already has a rolling forecast'));
    const state = await call({ method: 'POST', body: { name: 'RF', rolling: true } });
    expect([state.statusCode, state.sent.error?.details]).toEqual([409, { code: 'BUDGET_VERSION_STATE' }]);
    svc.status.mockRejectedValueOnce(new BudgetVersionError('BUDGET_VERSION_NOT_FOUND', 'Budget version not found'));
    expect((await call({ method: 'GET' })).statusCode).toBe(404);
    svc.create.mockRejectedValueOnce(new DriverRangeError('Actuals exceed the budget range', 'a'));
    const range = await call({ method: 'POST', body: { name: 'RF' } });
    expect([range.statusCode, range.sent.error?.details]).toEqual([400, { code: 'DRIVER_RANGE' }]);
  });

  it('anything else is not answered here (withErrorHandler makes it a 500)', async () => {
    svc.toggle.mockRejectedValue(new Error('boom'));
    await expect(call({ method: 'PUT', body: { rolling: true, expectedUpdatedAt: T } })).rejects.toThrow('boom');
  });
});
