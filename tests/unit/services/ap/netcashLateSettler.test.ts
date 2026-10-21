/**
 * AP-01 late settler.
 *   Round 14 (L1): startLateSettle ran `void run(...).finally(...)` with no catch - a throw outside run's own loop was
 *   an unhandled rejection with the answer nowhere. It is caught, logged with the full answer, the guard cleared.
 *   Round 15/16: an error from the answer's own content that can never clear (a data exception 22xxx, an integrity
 *   error 23xxx other than 23505) stops the settler at once with log.error, instead of retrying it for ten minutes; a
 *   transient one (a lock timeout 55P03, a 42P01/42501 around a migration or a grant) is retried.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const logged = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }));
const t = vi.hoisted(() => ({ throwOnFirstDelay: false }));
const settle = vi.hoisted(() => ({ settleOnFreshConnection: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: logged }));
vi.mock('@/modules/accounting/services/ap/netcashClaimSettle', () => settle);
vi.mock('@/modules/accounting/services/ap/netcashTimeouts', () => ({
  DEFAULT_LATE_SETTLE_TOTAL_MS: 400, LATE_SETTLE_MAX_DELAY_MS: 20,
  // Reading the backoff start is the first thing run() does outside its loop.
  get LATE_SETTLE_FIRST_DELAY_MS(): number { if (t.throwOnFirstDelay) throw new Error('boom outside the loop'); return 10; },
}));

import { isAnswerPendingRecord, startLateSettle } from '@/modules/accounting/services/ap/netcashLateSettler';

afterEach(() => { vi.clearAllMocks(); settle.settleOnFreshConnection.mockReset(); t.throwOnFirstDelay = false; });

const P = { companyId: 'c1', userId: 'u1', claims: {} };
const S = { status: 'submitted' as const, batchReference: 'NC-REF', netcashResponse: { outcome: 'accepted', batchReference: 'NC-REF' }, submittedAt: null };
const pgError = (code: string) => Object.assign(new Error(`pg ${code}`), { code });
const until = async (pred: () => boolean, ms: number) => { const end = Date.now() + ms; while (!pred() && Date.now() < end) await new Promise((r) => setTimeout(r, 5)); };

describe('startLateSettle', () => {
  it('a throw outside the retry loop is caught: logged with the full answer, no unhandled rejection, the guard cleared', async () => {
    t.throwOnFirstDelay = true;
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      startLateSettle(P, 'S-1', S, 'token-1');
      await new Promise((r) => setTimeout(r, 20));
      expect({
        unhandled: unhandled.mock.calls.length, guard: isAnswerPendingRecord('S-1'),
        logged: logged.error.mock.calls.some(([, d]) => JSON.stringify(d).includes('NC-REF') && JSON.stringify(d).includes('boom')),
      }).toEqual({ unhandled: 0, guard: false, logged: true });
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it.each(['22001', '22P05', '23502', '23514'])('a %s error never clears: one attempt, log.error with the answer, the guard cleared', async (code) => {
    settle.settleOnFreshConnection.mockRejectedValue(pgError(code));
    startLateSettle(P, `S-${code}`, S, 'token');
    await until(() => !isAnswerPendingRecord(`S-${code}`), 1000);
    expect({
      attempts: settle.settleOnFreshConnection.mock.calls.length, guard: isAnswerPendingRecord(`S-${code}`),
      logged: logged.error.mock.calls.some(([m, d]) => /cannot be written|never clear/i.test(String(m)) && JSON.stringify(d).includes('NC-REF')),
    }).toEqual({ attempts: 1, guard: false, logged: true });
  });

  it.each(['55P03', '57014', '23505', '40P01', '42P01', '42501'])('a %s error may clear: it is retried', async (code) => {
    settle.settleOnFreshConnection.mockRejectedValueOnce(pgError(code)).mockResolvedValueOnce({ kind: 'settled' });
    startLateSettle(P, `T-${code}`, S, 'token');
    await until(() => !isAnswerPendingRecord(`T-${code}`), 1000);
    expect(settle.settleOnFreshConnection).toHaveBeenCalledTimes(2);
  });
});
