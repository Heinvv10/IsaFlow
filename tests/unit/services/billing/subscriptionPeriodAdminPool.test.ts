/**
 * S-07e (migration 945): subscription_charges and subscriptions are not
 * writable by any app role, so every transition in subscriptionPeriod runs on
 * the migration_admin pool. The one atomic group, settling a charge and granting
 * the period it paid for, stays ONE transaction (k-033's invariant).
 */
import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

type Tx = MockedFunction<(...a: unknown[]) => Promise<unknown[]>>;
const h = vi.hoisted(() => ({ txs: [] as Array<{ label: string; calls: unknown[][] }>, script: [] as unknown[][] }));

vi.mock('@/lib/neon', () => ({ sql: vi.fn(() => { throw new Error('app-pool sql must not be used'); }) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/auth/migrationAdminPool', () => ({
  migrationAdminSqlTx: async (label: string, fn: (tx: Tx) => Promise<unknown>) => {
    const rec = { label, calls: [] as unknown[][] };
    h.txs.push(rec);
    const tx = (async (...args: unknown[]) => { rec.calls.push(args); return h.script.shift() ?? []; }) as Tx;
    return fn(tx);
  },
}));

import { log } from '@/lib/logger';
import {
  advancePeriodForSettledCharge,
  claimChargeAttempt,
  closeOutCancelledSubscriptions,
  markPastDueIfExhausted,
  settleSubscriptionCharge,
  voidChargesForCancellingSubscriptions,
} from '@/modules/billing/services/subscriptionPeriod';

const text = (call: unknown[] | undefined) => ((call?.[0] ?? []) as string[]).join('?').replace(/\s+/g, ' ');

beforeEach(() => {
  h.txs.length = 0;
  h.script.length = 0;
  vi.clearAllMocks();
});

describe('settleSubscriptionCharge', () => {
  it('settles the charge and advances the period in ONE migration_admin transaction', async () => {
    h.script.push([{ id: 'ch-1' }]); // the settle UPDATE matched
    await settleSubscriptionCharge('ch-1', 'co-1');

    expect(h.txs.map((t) => t.label)).toEqual(['subscription_settle_charge']);
    const calls = h.txs[0]!.calls;
    expect(calls).toHaveLength(2);
    expect(text(calls[0])).toMatch(/UPDATE subscription_charges SET status = 'settled'/);
    expect(text(calls[1])).toMatch(/UPDATE subscriptions s/);
    // Both statements are scoped to the charge's own company and id.
    expect(calls[0]!.slice(1)).toEqual(['ch-1', 'co-1', null, null]); // no paid amount: the cron's verify path
    expect(calls[1]!.slice(1)).toEqual(expect.arrayContaining(['ch-1', 'co-1']));
  });

  it.each([
    ['not in ZAR', { cents: 49900, currency: 'USD' }],
    ['with no currency', { cents: 49900 }],
    ['with no usable amount', { cents: null, currency: 'ZAR' }],
  ])('settles nothing for a webhook payment %s', async (_, paid) => {
    await settleSubscriptionCharge('ch-1', 'co-1', paid);
    expect(h.txs).toHaveLength(0);
    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/^Settlement refused/), expect.objectContaining({ chargeId: 'ch-1' }),
      'BillingCron');
  });

  it('grants no period for a charge that is no longer settleable, and says so', async () => {
    h.script.push([]); // cancelled charge: the guarded UPDATE matched nothing
    await settleSubscriptionCharge('ch-1', 'co-1');

    expect(h.txs[0]!.calls).toHaveLength(1);
    expect(log.warn).toHaveBeenCalledWith(
      'Settlement arrived for a charge that is no longer settleable',
      { chargeId: 'ch-1', companyId: 'co-1', paidCents: null },
      'BillingCron',
    );
  });
});

describe('the other transitions each run on the migration_admin pool', () => {
  it('advancePeriodForSettledCharge', async () => {
    await advancePeriodForSettledCharge('ch-1', 'co-1');
    expect(h.txs.map((t) => t.label)).toEqual(['subscription_advance_period']);
  });

  it('claimChargeAttempt returns the RETURNed attempt, or null when another run claimed it', async () => {
    h.script.push([{ attempt_count: 2 }], []);
    expect(await claimChargeAttempt('ch-1', 'queued', 1)).toBe(2);
    expect(await claimChargeAttempt('ch-1', 'queued', 1)).toBeNull();
    expect(h.txs.map((t) => t.label)).toEqual(['subscription_claim_attempt', 'subscription_claim_attempt']);
  });

  it('markPastDueIfExhausted writes nothing below the last attempt', async () => {
    await markPastDueIfExhausted('ch-1', 'co-1', 1);
    expect(h.txs).toHaveLength(0);
    await markPastDueIfExhausted('ch-1', 'co-1', 3);
    expect(h.txs.map((t) => t.label)).toEqual(['subscription_past_due']);
  });

  it('void and close-out return their row counts', async () => {
    h.script.push([{ id: 'a' }, { id: 'b' }], [{ id: 's' }]);
    expect(await voidChargesForCancellingSubscriptions()).toBe(2);
    expect(await closeOutCancelledSubscriptions(new Date('2026-10-25T00:00:00Z'))).toBe(1);
    expect(h.txs.map((t) => t.label)).toEqual(['subscription_void_charges', 'subscription_close_out']);
  });
});
