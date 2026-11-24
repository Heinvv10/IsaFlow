/**
 * POST /api/cron/subscription-charges: a live run resolves stale submissions,
 * generates due charges, then runs queued ones, and warns once when paid
 * subscriptions went unbilled for want of a mandate. ?dry_run=1 (or body
 * { dryRun: true }) runs only the read-only planners: nothing is written and
 * Paystack is never called.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  resolveStale: vi.fn(async () => 0),
  generate: vi.fn(async () => ({ created: 0, skipped: 0, unbilledNoMandate: 0, unbilled: [], cancelled: 0, voided: 0 })),
  run: vi.fn(async () => ({ submitted: 0, refundNeeded: 0, failed: 0, skipped: 0 })),
  plan: vi.fn(async () => [] as unknown[]),
  chargeable: vi.fn(async () => [] as unknown[]),
  warn: vi.fn(),
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: m.warn, error: vi.fn() } }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/modules/billing/services/subscriptionBillingService', () => ({ generateDueCharges: m.generate, runQueuedCharges: m.run }));
vi.mock('@/modules/billing/services/subscriptionChargeVerify', () => ({ resolveStaleSubmittedCharges: m.resolveStale }));
vi.mock('@/modules/billing/services/subscriptionChargePlan', () => ({ planDueCharges: m.plan, selectChargeableCharges: m.chargeable }));

import cronRoute from '../../../pages/api/cron/subscription-charges';

function res() {
  const r = { statusCode: 200, body: undefined as unknown,
    status(c: number) { r.statusCode = c; return r; }, json(b: unknown) { r.body = b; return r; }, setHeader() { return r; } };
  return r;
}
async function call(req: Record<string, unknown>) {
  const out = res();
  await (cronRoute as (q: unknown, s: unknown) => Promise<unknown>)({ headers: {}, socket: {}, query: {}, ...req }, out);
  return out;
}
const KEY = crypto.randomUUID();
const auth = { 'x-cron-secret': KEY };
const data = (r: { body: unknown }) => (r.body as { data: Record<string, unknown> }).data;
const planned = (outcome: string, i = 1) => ({
  outcome, companyId: `co-${i}`, subscriptionId: `sub-${i}`, mandateId: outcome === 'create' ? 'm-1' : null,
  periodStart: '2026-05-01', periodEnd: '2026-06-01', amountCents: 10000,
  currentPeriodEnd: '2026-05-01T00:00:00.000Z', daysOverdue: 3,
});
beforeEach(() => { vi.clearAllMocks(); process.env.CRON_SECRET = KEY; });

describe('/api/cron/subscription-charges', () => {
  it('a live run resolves, generates and runs, in that order', async () => {
    const r = await call({ method: 'POST', headers: auth });
    expect(r.statusCode).toBe(200);
    const order = [m.resolveStale, m.generate, m.run].map((f) => f.mock.invocationCallOrder[0]);
    expect(order).toEqual([...order].sort((a, b) => a! - b!));
    expect(m.plan).not.toHaveBeenCalled();
    expect(m.warn).not.toHaveBeenCalled();
  });

  it('a live run with unbilled subscriptions warns once and returns them', async () => {
    const unbilled = [{ companyId: 'co-1', subscriptionId: 'sub-1', currentPeriodEnd: '2026-05-01T00:00:00.000Z', daysOverdue: 3 }];
    m.generate.mockResolvedValueOnce({ created: 0, skipped: 0, unbilledNoMandate: 1, unbilled, cancelled: 0, voided: 0 } as never);
    const r = await call({ method: 'POST', headers: auth });
    expect(r.statusCode).toBe(200);
    expect(m.warn).toHaveBeenCalledTimes(1);
    expect(m.warn).toHaveBeenCalledWith(expect.any(String),
      expect.objectContaining({ reason: 'unbilled_no_mandate', count: 1, subscriptionIds: ['sub-1'] }), 'cron-subscription-charges');
    expect((data(r).generated as { unbilled: unknown }).unbilled).toEqual(unbilled);
  });

  it.each([[{ query: { dry_run: '1' } }], [{ query: { dry_run: 'true' } }], [{ body: { dryRun: true } }]])(
    'a dry run (%j) writes nothing and never charges, and returns the plan', async (extra) => {
      m.plan.mockResolvedValueOnce([planned('create', 1), planned('unbilled_no_mandate', 2), planned('skip_existing', 3), planned('skip_zero_amount', 4)]);
      m.chargeable.mockResolvedValueOnce([{ id: 'c-1' }, { id: 'c-2' }]);
      const r = await call({ method: 'POST', headers: auth, ...extra });
      expect(r.statusCode).toBe(200);
      expect(m.resolveStale).not.toHaveBeenCalled();
      expect(m.generate).not.toHaveBeenCalled();
      expect(m.run).not.toHaveBeenCalled();
      const d = data(r);
      expect(d.dryRun).toBe(true);
      expect(d.wouldCreate).toEqual([expect.objectContaining({ subscriptionId: 'sub-1', amountCents: 10000, daysOverdue: 3 })]);
      expect(d.unbilled).toEqual([expect.objectContaining({ subscriptionId: 'sub-2' })]);
      expect(d.skipped).toEqual({ existing: 1, zeroAmount: 1 });
      expect(d.wouldAttempt).toBe(2);
      expect(JSON.stringify(d)).not.toContain('m-1');
    });

  it('refuses a bad secret with 401 and runs nothing, dry run or not', async () => {
    for (const req of [{ headers: { 'x-cron-secret': 'wrong' } }, { headers: {}, query: { dry_run: '1' } }]) {
      expect((await call({ method: 'POST', ...req })).statusCode).toBe(401);
    }
    for (const f of [m.resolveStale, m.generate, m.run, m.plan, m.chargeable]) expect(f).not.toHaveBeenCalled();
  });
});
