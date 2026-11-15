/**
 * A close the readiness gate refuses is a 409 the screen can act on (Hein,
 * 2026-11-15): `error.details.code` is PERIOD_CLOSE_NOT_READY and
 * `error.details.periods` names each period with its failing checks (key,
 * label, reason, fixHref). Bulk Close keeps its per-period envelope (200, some
 * periods may have closed) and carries the same per-period blockers.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const svc = vi.hoisted(() => ({ closePeriod: vi.fn(), lockPeriod: vi.fn(), reopenPeriod: vi.fn(), closeYear: vi.fn() }));
const bulk = vi.hoisted(() => ({ runBulkPeriodAction: vi.fn() }));
vi.mock('@/modules/accounting/services/gl/fiscalPeriodService', () => svc);
vi.mock('@/modules/accounting/services/gl/fiscalPeriodBulk', () => bulk);
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (fn: unknown) => fn, withRole: () => (fn: unknown) => fn }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (fn: unknown) => fn }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (fn: unknown) => fn }));
vi.mock('@/lib/auth/impersonationGuard', () => ({
  respondIfImpersonationForbidden: () => false, ImpersonationForbiddenError: class extends Error {},
}));

import periodsAction from '../../../pages/api/accounting/fiscal-periods-action';
import {
  FiscalPeriodLockTimeoutError, PeriodCloseBlockedError, PeriodNotCloseableError, YearCloseBlockedError,
} from '@/modules/accounting/services/gl/periodCloseErrors';
import type { ChecklistItem } from '@/modules/accounting/services/gl/periodCloseReadinessService';

const BANK: ChecklistItem = {
  key: 'bank_reconciled', label: 'Bank reconciled', status: 'fail',
  reason: '1 unreconciled bank transaction remains in this period.', fixHref: '/accounting/bank-transactions',
};
const BANK_OUT = { key: BANK.key, label: BANK.label, reason: BANK.reason, fixHref: BANK.fixHref };

async function call(body: Record<string, unknown>) {
  const out = { status: 0, body: undefined as unknown };
  const res = {
    status(c: number) { out.status = c; return res; },
    json(b: unknown) { out.body = b; return res; },
    setHeader: vi.fn(),
  } as unknown as NextApiResponse;
  await (periodsAction as unknown as (q: NextApiRequest, s: NextApiResponse) => Promise<void>)(
    { method: 'POST', body: { ...body, confirm: true }, companyId: 'c1', user: { id: 'u1' } } as unknown as NextApiRequest, res);
  return out as { status: number; body: { success: boolean; data?: unknown; error?: { message: string; details?: unknown } } };
}

beforeEach(() => {
  vi.resetAllMocks(); // resets the once-queues too: a test that leaves one must not feed the next
});

describe('fiscal-periods-action: a refused close', () => {
  it('single close → 409 naming the failing checks', async () => {
    svc.closePeriod.mockRejectedValueOnce(new PeriodCloseBlockedError('January 2026', [BANK], [BANK], 'p1'));
    const r = await call({ action: 'close', id: 'p1' });
    expect(r.status).toBe(409);
    expect(r.body.error!.message).toMatch(/^January 2026 cannot be closed/);
    expect(r.body.error!.details).toEqual({
      code: 'PERIOD_CLOSE_NOT_READY',
      periods: [{ periodId: 'p1', periodName: 'January 2026', blockers: [BANK_OUT] }],
    });
  });

  it('close_year → 409 naming every failing period', async () => {
    svc.closeYear.mockRejectedValueOnce(new YearCloseBlockedError(2026, [
      { periodId: 'p1', periodName: 'January 2026', blockers: [BANK_OUT] },
      { periodId: 'p5', periodName: 'May 2026', blockers: [BANK_OUT] },
    ]));
    const r = await call({ action: 'close_year', fiscalYear: 2026 });
    expect(r.status).toBe(409);
    expect(r.body.error!.details).toMatchObject({
      code: 'PERIOD_CLOSE_NOT_READY', fiscalYear: 2026,
      periods: [{ periodId: 'p1' }, { periodId: 'p5' }],
    });
  });

  it('bulk close → the bulk service answers per period, as a 200 (refused rows carry their blockers)', async () => {
    const data = { okCount: 1, total: 2, results: [{ id: 'p1', ok: true }, { id: 'p2', ok: false, code: 'PERIOD_CLOSE_NOT_READY' }] };
    bulk.runBulkPeriodAction.mockResolvedValueOnce(data);
    const r = await call({ action: 'bulk_close', ids: ['p2', 'p1'] });
    expect(r.status).toBe(200);
    expect(bulk.runBulkPeriodAction).toHaveBeenCalledWith('c1', 'bulk_close', ['p2', 'p1'], 'u1');
    expect(r.body.data).toEqual(data);
  });

  it.each([
    ['close', { action: 'close', id: 'p1' }],
    ['bulk_close', { action: 'bulk_close', ids: ['p1', 'p2'] }],
  ])('%s: a held period is 503 + Retry-After (the request rolls back), never a 4xx that commits', async (_n, body) => {
    svc.closePeriod.mockRejectedValueOnce(new FiscalPeriodLockTimeoutError());
    bulk.runBulkPeriodAction.mockRejectedValueOnce(new FiscalPeriodLockTimeoutError());
    const r = await call(body);
    expect(r.status).toBe(503);
    expect(r.body.error!.message).toMatch(/^Another request is holding a fiscal period or its financial year/);
  });

  it('arch C: an untyped error from a bulk action is rethrown (a 500 that rolls back), never a 400 that commits', async () => {
    const boom = new Error('an untyped fault inside the close');
    bulk.runBulkPeriodAction.mockRejectedValueOnce(boom);
    await expect(call({ action: 'bulk_close', ids: ['p1', 'p2'] })).rejects.toBe(boom);
  });

  it('a driver error (SQLSTATE) is rethrown — a 500 that rolls back — never a 400 that commits', async () => {
    bulk.runBulkPeriodAction.mockRejectedValueOnce(Object.assign(new Error('current transaction is aborted'), { code: '25P02' }));
    await expect(call({ action: 'bulk_close', ids: ['p1'] })).rejects.toMatchObject({ code: '25P02' });
  });

  it('any other refusal stays a 400 with its message', async () => {
    svc.closePeriod.mockRejectedValueOnce(new PeriodNotCloseableError('Period is already closed'));
    const r = await call({ action: 'close', id: 'p1' });
    expect(r.status).toBe(400);
    expect(r.body.error!.message).toBe('Period is already closed');
  });
});
