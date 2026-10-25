/**
 * S-07e: a Flows debit commits on its own migration_admin transaction, so a
 * request that rolls back after the handler answered 2xx (a failed COMMIT,
 * rollbackOnly) would keep the charge. runAfterRollback queues the undo on the
 * request context; the owner (withAuth, the bearer pipeline) starts it when its
 * transaction does not commit, and drops it when it does. The real
 * AsyncLocalStorage is used.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const h = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: h.warn, error: h.error, debug: vi.fn() } }));
vi.mock('@/lib/billing/getCompanyPlan', () => ({ getCompanyPlan: vi.fn(async () => ({ planCode: 'payg' })) }));
vi.mock('@/modules/billing/services/flowWalletService', () => ({
  deductFlows: vi.fn(async () => ({ balanceAfter: 90 })),
  refundFlows: vi.fn(async () => ({ balanceAfter: 100 })),
  triggerAutoTopup: vi.fn(),
  recalculateNudge: vi.fn(async () => 'none'),
  InsufficientFlowsError: class extends Error {},
}));

import { als, type RequestContext } from '@/lib/als';
import { runAfterRollback, settleAfterRollback } from '@/lib/afterCommit';
import { withFlowMeter } from '@/lib/billing/withFlowMeter';
import { refundFlows } from '@/modules/billing/services/flowWalletService';

const ctx = (extra: Partial<RequestContext> = {}) =>
  ({ client: {}, userId: 'u1', companyId: 'co-1', claims: {}, afterCommit: [], afterRollback: [], ...extra }) as unknown as RequestContext;
const flush = () => new Promise((r) => setImmediate(r));

beforeEach(() => vi.clearAllMocks());

describe('runAfterRollback / settleAfterRollback', () => {
  it('runs the queued work, outside the request context, when the transaction did not commit', async () => {
    const c = ctx();
    let sawStore: unknown = 'unset';
    als.run(c, () => runAfterRollback('undo', async () => { sawStore = als.getStore(); }));
    settleAfterRollback(c, false);
    await flush();
    expect(sawStore).toBeUndefined();
    expect(c.afterRollback).toBeUndefined();
  });

  it('drops the queued work when the transaction committed', async () => {
    const c = ctx();
    const fn = vi.fn(async () => undefined);
    als.run(c, () => runAfterRollback('undo', fn));
    settleAfterRollback(c, true);
    await flush();
    expect(fn).not.toHaveBeenCalled();
  });

  it('logs, and never throws into the request, when the work fails', async () => {
    const c = ctx();
    als.run(c, () => runAfterRollback('undo', async () => { throw new Error('refund down'); }));
    settleAfterRollback(c, false);
    await flush();
    expect(h.error).toHaveBeenCalledWith('after-commit work failed', { label: 'undo', error: 'refund down' }, 'DB');
  });

  it('drops the work with a warning, rather than failing a request whose owner keeps no queue', () => {
    const c = ctx({ afterRollback: undefined });
    expect(() => als.run(c, () => runAfterRollback('undo', async () => undefined))).not.toThrow();
    expect(h.warn).toHaveBeenCalledWith(expect.stringMatching(/no after-rollback queue/), expect.anything(), 'DB');
  });

  it('is a no-op outside any request (nothing to roll back)', () => {
    expect(() => runAfterRollback('undo', async () => undefined)).not.toThrow();
  });
});

describe('withFlowMeter queues its refund for a request that rolls back after a 2xx', () => {
  const res = () => ({ statusCode: 200, headersSent: false, setHeader: vi.fn(), status() { return this; } }) as unknown as NextApiResponse;
  const run = async (c: RequestContext) => {
    const handler = withFlowMeter('report.age', 2)(async (_req, r) => { r.statusCode = 200; });
    await als.run(c, () => handler({ companyId: 'co-1' } as unknown as NextApiRequest, res()));
  };

  it('refunds the debit when the request then rolls back', async () => {
    const c = ctx();
    await run(c);
    expect(refundFlows).not.toHaveBeenCalled();
    settleAfterRollback(c, false);
    await flush();
    expect(refundFlows).toHaveBeenCalledWith('co-1', 2, 'report.age', null);
  });

  it('keeps the debit when the request commits', async () => {
    const c = ctx();
    await run(c);
    settleAfterRollback(c, true);
    await flush();
    expect(refundFlows).not.toHaveBeenCalled();
  });
});
