/**
 * AP-01 round 14 (L1): startLateSettle ran `void run(...).finally(...)` with no catch - a throw outside run's own loop
 * was an unhandled rejection (which can end the process) with the answer nowhere. It is caught, logged with the full
 * answer, and the in-process guard is cleared.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const logged = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: logged }));
vi.mock('@/modules/accounting/services/ap/netcashClaimSettle', () => ({ settleOnFreshConnection: vi.fn() }));
// Reading the backoff start is the first thing run() does outside its loop: make it throw.
vi.mock('@/modules/accounting/services/ap/netcashTimeouts', () => ({
  DEFAULT_LATE_SETTLE_TOTAL_MS: 1000, LATE_SETTLE_MAX_DELAY_MS: 10,
  get LATE_SETTLE_FIRST_DELAY_MS(): number { throw new Error('boom outside the loop'); },
}));

import { isAnswerPendingRecord, startLateSettle } from '@/modules/accounting/services/ap/netcashLateSettler';

afterEach(() => { vi.clearAllMocks(); });

describe('startLateSettle', () => {
  it('a throw outside the retry loop is caught: logged with the full answer, no unhandled rejection, the guard cleared', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      startLateSettle({ companyId: 'c1', userId: 'u1', claims: {} }, 'S-1', {
        status: 'submitted', batchReference: 'NC-REF', netcashResponse: { outcome: 'accepted', batchReference: 'NC-REF' }, submittedAt: null,
      }, 'token-1');
      await new Promise((r) => setTimeout(r, 20));
      expect({
        unhandled: unhandled.mock.calls.length, guard: isAnswerPendingRecord('S-1'),
        logged: logged.error.mock.calls.some(([, d]) => JSON.stringify(d).includes('NC-REF') && JSON.stringify(d).includes('boom')),
      }).toEqual({ unhandled: 0, guard: false, logged: true });
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});
