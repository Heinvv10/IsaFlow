/**
 * The four budget-drivers routes (Budgets P4 PR-3), driven for real with the services mocked:
 * methods, the CSRF check and role gate (the REAL withCsrf and withWriteAccess), body validation
 * (a kind's own fields, months, UUIDs, the version token every write must carry), the user's write bucket (reads are not charged), the
 * company taken from the session never the body, and each refusal's status and contract code:
 * DRIVER_CYCLE with its path, DRIVER_REF, DRIVER_RANGE (400), BUDGET_VERSION_LOCKED and
 * BUDGET_VERSION_STALE with the current token and status (409).
 *
 * Mutation check: drop withCsrf or withWriteAccess from a route, read companyId from the body,
 * or answer a driver error as 500, and the matching test goes red.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const svc = vi.hoisted(() => ({
  listDrivers: vi.fn(), saveDriver: vi.fn(), deleteDriver: vi.fn(), resetOverride: vi.fn(), refreshHeadcount: vi.fn(),
  listHires: vi.fn(), createHire: vi.fn(), updateHire: vi.fn(), deleteHire: vi.fn(), readHeadcount: vi.fn(), rateLimit: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/rateLimit', () => ({ checkRateLimit: (...a: unknown[]) => svc.rateLimit(...a) }));
// withAuth needs a database and a session: stubbed. withCsrf and withWriteAccess are the real wrappers.
vi.mock('@/lib/auth', async () => ({
  withAuth: (h: unknown) => h,
  withWriteAccess: (await vi.importActual<typeof import('@/lib/auth/withWriteAccess')>('@/lib/auth/withWriteAccess')).withWriteAccess,
}));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/modules/accounting/services/budgets/drivers/driverWriteService', () => ({
  listDrivers: svc.listDrivers, saveDriver: svc.saveDriver, deleteDriver: svc.deleteDriver,
  resetOverride: svc.resetOverride, refreshHeadcount: svc.refreshHeadcount,
}));
vi.mock('@/modules/accounting/services/budgets/drivers/plannedHireService', () => ({
  listHires: svc.listHires, createHire: svc.createHire, updateHire: svc.updateHire, deleteHire: svc.deleteHire,
  readHeadcount: svc.readHeadcount,
}));

import driversRoute from '../../../pages/api/accounting/budget-drivers/index';
import overrideRoute from '../../../pages/api/accounting/budget-drivers/override';
import headcountRoute from '../../../pages/api/accounting/budget-drivers/headcount';
import hiresRoute from '../../../pages/api/accounting/budget-drivers/planned-hires';
import { DriverCycleError, DriverRangeError, DriverRefError } from '@/modules/accounting/services/budgets/drivers/driverTypes';
import { BudgetVersionError } from '@/modules/accounting/services/budgets/budgetVersionTypes';
import { BudgetVersionStaleError } from '@/modules/accounting/services/budgets/versionTake';
import { BudgetDriverError } from '@/modules/accounting/services/budgets/drivers/driverErrors';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const FOREIGN = '22222222-2222-4222-8222-222222222222';
const V = '33333333-3333-4333-8333-333333333333';
const ACCT = '44444444-4444-4444-8444-444444444444';
const REF = '55555555-5555-4555-8555-555555555555';
const CSRF = 'c'.repeat(48);
const T = '2026-10-29T07:17:00.307234Z';

type Route = (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>;

async function call(route: Route, over: Record<string, unknown>) {
  const req = {
    method: 'GET', query: {}, body: undefined, cookies: { isaflow_csrf: CSRF }, headers: { 'x-csrf-token': CSRF },
    companyId: COMPANY, companyRole: 'admin', user: { id: 'user-1', claims: {} }, ...over,
  } as unknown as NextApiRequest;
  const res = {
    statusCode: 0, sent: undefined as unknown,
    setHeader() { return this; },
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.sent = payload; return this; },
    end() { return this; },
  };
  await route(req, res as unknown as NextApiResponse);
  return res as typeof res & { sent: { data?: unknown; error?: { message?: string; details?: Record<string, unknown> } } };
}

const fixed = { versionId: V, expectedUpdatedAt: T, glAccountId: ACCT, kind: 'fixed', amount: 1500, fromMonth: '2026-03', toMonth: '2027-02' };

beforeEach(() => {
  for (const f of Object.values(svc)) f.mockReset();
  svc.rateLimit.mockResolvedValue(true);
  svc.saveDriver.mockResolvedValue({ driver: { id: 'd1' }, updatedAt: 't', recomputed: 0, warnings: [] });
  svc.listDrivers.mockResolvedValue({ drivers: [] });
});

describe('budget-drivers routes: methods, CSRF, roles and the bucket', () => {
  it('refuses a method each route does not answer (405)', async () => {
    expect((await call(driversRoute as Route, { method: 'POST' })).statusCode).toBe(405);
    expect((await call(overrideRoute as Route, { method: 'GET' })).statusCode).toBe(405);
    expect((await call(headcountRoute as Route, { method: 'DELETE' })).statusCode).toBe(405);
    expect((await call(hiresRoute as Route, { method: 'PATCH' })).statusCode).toBe(405);
  });

  it('a write without the CSRF token is 403 and reaches no service', async () => {
    const r = await call(driversRoute as Route, { method: 'PUT', body: fixed, headers: {} });
    expect(r.statusCode).toBe(403);
    expect(svc.saveDriver).not.toHaveBeenCalled();
  });

  it('a viewer may read but not write', async () => {
    expect((await call(driversRoute as Route, { method: 'GET', query: { versionId: V }, companyRole: 'viewer' })).statusCode).toBe(200);
    for (const [route, method, body] of [
      [driversRoute, 'PUT', fixed], [overrideRoute, 'POST', { versionId: V, expectedUpdatedAt: T, glAccountId: ACCT }],
      [headcountRoute, 'POST', { versionId: V, expectedUpdatedAt: T }],
      [hiresRoute, 'POST', { versionId: V, expectedUpdatedAt: T, label: 'X', startMonth: '2026-04' }],
    ] as const) {
      expect((await call(route as Route, { method, body, companyRole: 'viewer' })).statusCode).toBe(403);
    }
    expect(svc.saveDriver).not.toHaveBeenCalled();
    expect(svc.resetOverride).not.toHaveBeenCalled();
  });

  it("a viewer reads company headcount, but a cost centre's is 403 before the service runs", async () => {
    svc.readHeadcount.mockResolvedValue({ costCentreId: null, months: [], asOf: 't' });
    const CC = '66666666-6666-4666-8666-666666666666';
    expect((await call(headcountRoute as Route, { method: 'GET', query: { versionId: V }, companyRole: 'viewer' })).statusCode).toBe(200);
    expect((await call(headcountRoute as Route, { method: 'GET', query: { versionId: V, costCentreId: CC }, companyRole: 'viewer' })).statusCode).toBe(403);
    expect(svc.readHeadcount).toHaveBeenCalledTimes(1);
    expect((await call(headcountRoute as Route, { method: 'GET', query: { versionId: V, costCentreId: CC }, companyRole: 'manager' })).statusCode).toBe(200);
    expect(svc.readHeadcount).toHaveBeenLastCalledWith(COMPANY, V, CC);
  });

  it('charges writes to the budget-driver bucket (429 past it) and never reads', async () => {
    await call(driversRoute as Route, { method: 'GET', query: { versionId: V } });
    expect(svc.rateLimit).not.toHaveBeenCalled();
    svc.rateLimit.mockResolvedValue(false);
    const r = await call(driversRoute as Route, { method: 'PUT', body: fixed });
    expect(r.statusCode).toBe(429);
    expect(svc.rateLimit).toHaveBeenCalledWith('budget-driver:user-1', { max: 120, windowSecs: 60 });
    expect(svc.saveDriver).not.toHaveBeenCalled();
  });
});

describe('budget-drivers routes: bodies', () => {
  it("passes the session's company, never one in the body, and only the kind's own fields", async () => {
    const r = await call(driversRoute as Route, { method: 'PUT', body: { ...fixed, companyId: FOREIGN, pct: 5, ref: { glAccountId: REF } } });
    expect(r.statusCode).toBe(200);
    expect(svc.saveDriver).toHaveBeenCalledWith(COMPANY, 'user-1', { versionId: V, expectedUpdatedAt: T }, {
      glAccountId: ACCT, cc1Id: null, cc2Id: null, buId: null, kind: 'fixed', amount: 1500, fromMonth: '2026-03', toMonth: '2027-02', rounding: 1,
    });
  });

  it("refuses a body missing its kind's field, a bad month, rounding unit or id (422), and a bad query id (400)", async () => {
    for (const body of [
      { ...fixed, amount: undefined }, { ...fixed, kind: 'pct_of_line', pct: 5 }, { ...fixed, fromMonth: '2026-13' },
      { ...fixed, rounding: 10 }, { ...fixed, glAccountId: 'nope' }, { ...fixed, kind: 'nonsense' },
      { ...fixed, expectedUpdatedAt: undefined }, { ...fixed, expectedUpdatedAt: '2026-02-30T00:00:00Z' },
    ]) {
      expect((await call(driversRoute as Route, { method: 'PUT', body })).statusCode, JSON.stringify(body)).toBe(422);
    }
    expect((await call(driversRoute as Route, { method: 'GET', query: { versionId: 'x' } })).statusCode).toBe(400);
    expect((await call(driversRoute as Route, { method: 'DELETE', query: { versionId: V, id: 'x', expectedUpdatedAt: T } })).statusCode).toBe(400);
    expect((await call(driversRoute as Route, { method: 'DELETE', query: { versionId: V, id: REF } })).statusCode).toBe(400);
    expect((await call(hiresRoute as Route, { method: 'DELETE', query: { versionId: V, id: REF, expectedUpdatedAt: 'x' } })).statusCode).toBe(400);
    expect((await call(headcountRoute as Route, { method: 'POST', body: { versionId: V } })).statusCode).toBe(422);
    expect((await call(hiresRoute as Route, { method: 'POST', body: { versionId: V, expectedUpdatedAt: T, label: 'X', startMonth: '26-04' } })).statusCode).toBe(422);
    expect((await call(headcountRoute as Route, { method: 'GET', query: { versionId: V, costCentreId: 'x' } })).statusCode).toBe(400);
    expect(svc.saveDriver).not.toHaveBeenCalled();
    expect(svc.deleteDriver).not.toHaveBeenCalled();
    expect(svc.deleteHire).not.toHaveBeenCalled();
    expect(svc.refreshHeadcount).not.toHaveBeenCalled();
  });

  it('passes the token of a DELETE from its query', async () => {
    svc.deleteHire.mockResolvedValue({ deleted: true, id: REF });
    expect((await call(hiresRoute as Route, { method: 'DELETE', query: { versionId: V, id: REF, expectedUpdatedAt: T } })).statusCode).toBe(200);
    expect(svc.deleteHire).toHaveBeenCalledWith(COMPANY, 'user-1', { versionId: V, expectedUpdatedAt: T }, REF);
  });
});

describe('budget-drivers routes: refusals', () => {
  it('a cycle is 400 DRIVER_CYCLE with its path', async () => {
    svc.saveDriver.mockRejectedValue(new DriverCycleError(['a|||', 'b|||', 'a|||']));
    const r = await call(driversRoute as Route, { method: 'PUT', body: fixed });
    expect(r.statusCode).toBe(400);
    expect(r.sent.error?.details).toEqual({ code: 'DRIVER_CYCLE', path: ['a|||', 'b|||', 'a|||'] });
  });

  it('a bad reference or range is 400 DRIVER_REF / DRIVER_RANGE; a locked version 409 BUDGET_VERSION_LOCKED', async () => {
    svc.saveDriver.mockRejectedValueOnce(new DriverRefError('outside the version'));
    expect((await call(driversRoute as Route, { method: 'PUT', body: fixed })).sent.error?.details).toEqual({ code: 'DRIVER_REF' });
    svc.resetOverride.mockRejectedValueOnce(new DriverRangeError('too big', 'a|||'));
    const range = await call(overrideRoute as Route, { method: 'POST', body: { versionId: V, expectedUpdatedAt: T, glAccountId: ACCT } });
    expect([range.statusCode, range.sent.error?.details]).toEqual([400, { code: 'DRIVER_RANGE' }]);
    svc.createHire.mockRejectedValueOnce(new BudgetVersionError('BUDGET_VERSION_LOCKED', 'This budget version is locked'));
    const locked = await call(hiresRoute as Route, { method: 'POST', body: { versionId: V, expectedUpdatedAt: T, label: 'X', startMonth: '2026-04' } });
    expect([locked.statusCode, locked.sent.error?.details]).toEqual([409, { code: 'BUDGET_VERSION_LOCKED' }]);
  });

  it('a missing driver or hire is 404 DRIVER_NOT_FOUND / PLANNED_HIRE_NOT_FOUND', async () => {
    svc.deleteDriver.mockRejectedValue(new BudgetDriverError('DRIVER_NOT_FOUND', 'Budget driver not found in this version'));
    const d = await call(driversRoute as Route, { method: 'DELETE', query: { versionId: V, id: REF, expectedUpdatedAt: T } });
    expect([d.statusCode, d.sent.error?.details]).toEqual([404, { code: 'DRIVER_NOT_FOUND' }]);
    svc.deleteHire.mockRejectedValue(new BudgetDriverError('PLANNED_HIRE_NOT_FOUND', 'Planned hire not found in this version'));
    const h = await call(hiresRoute as Route, { method: 'DELETE', query: { versionId: V, id: REF, expectedUpdatedAt: T } });
    expect([h.statusCode, h.sent.error?.details]).toEqual([404, { code: 'PLANNED_HIRE_NOT_FOUND' }]);
  });

  it('a stale token is 409 BUDGET_VERSION_STALE with the current token and status', async () => {
    svc.saveDriver.mockRejectedValue(new BudgetVersionStaleError('2026-10-29T08:00:00.000001Z', 'approved'));
    const r = await call(driversRoute as Route, { method: 'PUT', body: fixed });
    expect([r.statusCode, r.sent.error?.details]).toEqual([409, { code: 'BUDGET_VERSION_STALE', currentUpdatedAt: '2026-10-29T08:00:00.000001Z', status: 'approved' }]);
  });

  it('anything else is not answered here (withErrorHandler makes it a 500)', async () => {
    svc.deleteDriver.mockRejectedValue(new Error('boom'));
    await expect(call(driversRoute as Route, { method: 'DELETE', query: { versionId: V, id: REF, expectedUpdatedAt: T } })).rejects.toThrow('boom');
  });
});
