/**
 * /api/accounting/vat-period-locks — who may lock and unlock, and what the lock records.
 *
 * Unlocking reopens a FILED VAT return to change, so it is owner/admin only and
 * that gate lives here, at the route (there is no MCP unlock). Locking is any
 * writer's, and records the SAME figures the MCP lock_vat_period tool records
 * (computeVatLockFigures), refusing a return that fails the 15% check unless
 * forced. The service behaviour itself is pinned against a real database in
 * tests/integration/vat-period-lock-unlock.int.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', async () => ({
  withAuth: (fn: unknown) => fn,
  withWriteAccess: (fn: unknown) => fn,
  // The REAL role gate: this file is about who it lets through.
  withRole: (await vi.importActual<typeof import('@/lib/auth/withRole')>('@/lib/auth/withRole')).withRole,
}));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (fn: unknown) => fn }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (fn: unknown) => fn }));
vi.mock('@/lib/apiResponse', () => ({
  apiResponse: {
    success: vi.fn((_res: unknown, data: unknown) => ({ kind: 'success', data })),
    badRequest: vi.fn((_res: unknown, error: string) => ({ kind: 'badRequest', error })),
    conflict: vi.fn((_res: unknown, error: string) => ({ kind: 'conflict', error })),
    validationError: vi.fn((_res: unknown, errors: unknown) => ({ kind: 'validationError', errors })),
    methodNotAllowed: vi.fn(() => ({ kind: 'methodNotAllowed' })),
  },
}));

const m = vi.hoisted(() => ({
  lockVatPeriod: vi.fn(),
  unlockVatPeriod: vi.fn(),
  getVatPeriodLock: vi.fn(),
  listVatPeriodLocks: vi.fn(),
  computeVatLockFigures: vi.fn(),
}));
vi.mock('@/modules/accounting/services/reports/vatPeriodLockService', () => {
  class VatPeriodLockRefusal extends Error {}
  return {
    lockVatPeriod: m.lockVatPeriod,
    unlockVatPeriod: m.unlockVatPeriod,
    getVatPeriodLock: m.getVatPeriodLock,
    listVatPeriodLocks: m.listVatPeriodLocks,
    VatPeriodLockRefusal,
    VatPeriodUnlockRefusal: class VatPeriodUnlockRefusal extends VatPeriodLockRefusal {},
    VatLockTimeoutError: class VatLockTimeoutError extends Error {},
  };
});
vi.mock('@/modules/accounting/services/reports/vatPeriodLockFigures', () => ({
  computeVatLockFigures: m.computeVatLockFigures,
}));

import handler from '../../../pages/api/accounting/vat-period-locks';
import {
  VatLockTimeoutError, VatPeriodLockRefusal, VatPeriodUnlockRefusal,
} from '@/modules/accounting/services/reports/vatPeriodLockService';

const COMPANY = 'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa';
const USER = 'bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb';
const LOCK_ID = 'cccccccc-0000-4000-8000-cccccccccccc';
const FIGURES = { outputTax: 150, inputTax: 45, netVat: 105, postedThrough: '2026-04-30T10:00:00.000Z' };

type Out = { kind: string; data?: unknown; error?: string; status?: number };

function call(role: string, body: unknown, method = 'POST'): Promise<Out> {
  let status = 0;
  const res = {
    status: (s: number) => { status = s; return { json: (b: unknown) => ({ kind: 'status', status, data: b }) }; },
  } as unknown as NextApiResponse;
  const req = { method, body, companyId: COMPANY, companyRole: role, user: { id: USER } } as unknown as NextApiRequest;
  return (handler as unknown as (r: NextApiRequest, s: NextApiResponse) => Promise<Out>)(req, res);
}

const unlockBody = { action: 'unlock', lockId: LOCK_ID, reason: 'Amending the March return' };
const lockBody = { action: 'lock', periodStart: '2026-03-01', periodEnd: '2026-04-30', notes: 'eFiling 1' };

beforeEach(() => {
  vi.clearAllMocks();
  m.unlockVatPeriod.mockResolvedValue({ id: LOCK_ID, active: false });
  m.getVatPeriodLock.mockResolvedValue(null);
  m.computeVatLockFigures.mockResolvedValue({ figures: FIGURES, report: { rateCheck: { ties: true } } });
  m.lockVatPeriod.mockResolvedValue({ lock: { id: LOCK_ID }, created: true });
});

describe('unlock is owner/admin only', () => {
  it.each(['viewer', 'manager', 'technician'])('refuses %s with 403 and never reaches the service', async (role) => {
    const out = await call(role, unlockBody);
    expect(out).toMatchObject({ kind: 'status', status: 403 });
    expect(m.unlockVatPeriod).not.toHaveBeenCalled();
  });

  it.each(['admin', 'owner'])('lets %s unlock, with the authenticated user and the reason', async (role) => {
    const out = await call(role, unlockBody);
    expect(out.kind).toBe('success');
    expect(m.unlockVatPeriod).toHaveBeenCalledWith(COMPANY, LOCK_ID, USER, 'Amending the March return');
  });

  it('answers a service refusal with a 400 carrying its message', async () => {
    m.unlockVatPeriod.mockRejectedValue(new VatPeriodUnlockRefusal('This VAT period lock is already unlocked.'));
    expect(await call('admin', unlockBody)).toEqual({ kind: 'badRequest', error: 'This VAT period lock is already unlocked.' });
  });

  it('rejects a blank reason before any role or service is consulted', async () => {
    const out = await call('admin', { ...unlockBody, reason: '   ' });
    expect(out.kind).toBe('validationError');
    expect(m.unlockVatPeriod).not.toHaveBeenCalled();
  });
});

describe('lock', () => {
  it('records the figures computeVatLockFigures produced, as a human lock', async () => {
    const out = await call('manager', lockBody);
    expect(out.kind).toBe('success');
    expect(m.computeVatLockFigures).toHaveBeenCalledWith(COMPANY, '2026-03-01', '2026-04-30');
    expect(m.lockVatPeriod).toHaveBeenCalledWith(
      COMPANY, '2026-03-01', '2026-04-30', FIGURES, { userId: USER, actorType: 'human' }, 'eFiling 1',
    );
  });

  it('refuses a period failing the 15% check unless forced', async () => {
    m.computeVatLockFigures.mockResolvedValue({
      figures: FIGURES, report: { rateCheck: { ties: false, outputVariance: 12, inputVariance: 0 } },
    });
    const refused = await call('admin', lockBody);
    expect(refused.kind).toBe('badRequest');
    expect(m.lockVatPeriod).not.toHaveBeenCalled();
    expect((await call('admin', { ...lockBody, force: true })).kind).toBe('success');
    expect(m.lockVatPeriod).toHaveBeenCalledTimes(1);
  });

  it('answers the service bounds refusal (future end, >12 months, overlap) with a 400', async () => {
    m.lockVatPeriod.mockRejectedValue(new VatPeriodLockRefusal('overlaps the locked VAT period 2026-03-01 to 2026-04-30'));
    expect(await call('admin', lockBody)).toEqual({
      kind: 'badRequest', error: 'overlaps the locked VAT period 2026-03-01 to 2026-04-30',
    });
  });

  it('answers a lock timeout (posts in flight) with a retryable 409, for lock and unlock', async () => {
    m.computeVatLockFigures.mockRejectedValue(new VatLockTimeoutError('retry'));
    expect((await call('admin', lockBody)).kind).toBe('conflict');
    m.unlockVatPeriod.mockRejectedValue(new VatLockTimeoutError('retry'));
    expect((await call('admin', unlockBody)).kind).toBe('conflict');
  });

  it('refuses a period that runs backwards', async () => {
    const out = await call('admin', { ...lockBody, periodStart: '2026-05-01' });
    expect(out.kind).toBe('badRequest');
    expect(m.computeVatLockFigures).not.toHaveBeenCalled();
  });
});

it('GET lists locks including history', async () => {
  m.listVatPeriodLocks.mockResolvedValue([{ id: LOCK_ID, active: false }]);
  expect(await call('viewer', undefined, 'GET')).toEqual({ kind: 'success', data: { locks: [{ id: LOCK_ID, active: false }] } });
});
