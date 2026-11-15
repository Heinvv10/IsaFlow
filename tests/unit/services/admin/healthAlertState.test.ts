/**
 * healthAlertState (admin audit OP-1, review round 2):
 *  - every entry point refuses to run inside a request transaction (an ALS store), where its
 *    claim would be a savepoint that commits only with the request (L2);
 *  - the "last alert could not be delivered" verdict comes from the later of the two outcome
 *    stamps. The claim and release on real rows are pinned in
 *    tests/integration/admin-health-alert-claim.int.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';

const withTransaction = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('@/lib/neon', () => ({ withTransaction }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { als } from '@/lib/als';
import {
  claimAlert, lastDeliveryFailed, markHealthy, recordDeliveryOutcome, recordScheduledRun, releaseClaim,
} from '@/modules/admin/services/healthAlertState';

const CLAIM = { status: 'critical' as const, claimedAt: '2026-11-15T10:00:00.000Z', previous: { status: null, sentAt: null } };
const inRequest = <T,>(fn: () => Promise<T>) =>
  als.run({ client: {} as never, userId: 'u', claims: {} }, fn);

describe('healthAlertState refuses a request transaction', () => {
  it.each([
    ['claimAlert', () => claimAlert('critical')],
    ['releaseClaim', () => releaseClaim(CLAIM)],
    ['markHealthy', () => markHealthy()],
    ['recordScheduledRun', () => recordScheduledRun()],
    ['recordDeliveryOutcome', () => recordDeliveryOutcome(false)],
  ])('%s throws inside an ALS store and never opens a transaction', async (name, fn) => {
    withTransaction.mockClear();
    await expect(inRequest(fn)).rejects.toThrow(`healthAlertState.${name} must run outside a request transaction`);
    expect(withTransaction).not.toHaveBeenCalled();
  });

  it('outside a store it goes on to its own transaction', async () => {
    withTransaction.mockClear();
    await recordScheduledRun();
    expect(withTransaction).toHaveBeenCalledTimes(1);
  });
});

describe('lastDeliveryFailed', () => {
  const T = (m: number) => new Date(Date.UTC(2026, 10, 15, 10, m)).toISOString();
  it.each([
    [null, null, false],
    [T(5), null, false],
    [null, T(5), true],
    [T(4), T(5), true],
    [T(6), T(5), false],
    [T(5), 'garbage', false],
  ])('delivered %s, failed %s -> %s', (delivered, failed, expected) => {
    expect(lastDeliveryFailed(delivered, failed)).toBe(expected);
  });
});
