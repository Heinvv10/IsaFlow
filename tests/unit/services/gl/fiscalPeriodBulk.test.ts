/**
 * Bulk Close / Lock / Reopen (fiscalPeriodBulk): every id is locked up front in
 * one statement in (fiscal_year, period_number, id) order and processed in that
 * order, each in its own savepoint. A refusal is that period's row; anything
 * else (a held row, a deadlock, an aborted transaction, a driver error) fails
 * the whole request, so no response can say `ok: true` for a write that rolls
 * back.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  queries: [] as Array<{ text: string; values: unknown[] }>,
  locked: [] as string[],
  savepoints: [] as string[],
}));

vi.mock('@/lib/neon', () => ({
  sql: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    h.queries.push({ text: strings.join('?').replace(/\s+/g, ' ').trim(), values });
    return h.locked.map((id) => ({ id }));
  }),
  withSavepoint: vi.fn(async (name: string, fn: () => Promise<unknown>) => { h.savepoints.push(name); return fn(); }),
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/modules/accounting/services/gl/periodCloseGate', () => ({
  withPeriodLockBudget: (fn: () => Promise<unknown>) => fn(),
}));
vi.mock('@/modules/accounting/services/gl/fiscalPeriodCloseWrites', () => ({
  closePeriodWithVerdict: vi.fn(async () => ({})),
  lockPeriod: vi.fn(async () => ({})),
  reopenPeriod: vi.fn(async () => ({})),
}));

import { closePeriodWithVerdict, lockPeriod } from '@/modules/accounting/services/gl/fiscalPeriodCloseWrites';
import { runBulkPeriodAction } from '@/modules/accounting/services/gl/fiscalPeriodBulk';
import {
  FiscalPeriodLockTimeoutError, PeriodCloseBlockedError, PeriodNotCloseableError,
} from '@/modules/accounting/services/gl/periodCloseErrors';

const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const JAN = '11111111-1111-4111-8111-111111111111';
const FEB = '22222222-2222-4222-8222-222222222222';
const MAR = '33333333-3333-4333-8333-333333333333';
const OTHER_CO = '99999999-9999-4999-8999-999999999999';

const BANK = { key: 'bank_reconciled' as const, label: 'Bank reconciled', status: 'fail' as const, reason: '1 unreconciled', fixHref: '/accounting/bank-transactions' };

beforeEach(() => {
  vi.clearAllMocks();
  h.queries = []; h.savepoints = [];
  h.locked = [JAN, FEB, MAR]; // what the ordered lock statement returns: period order
});

describe('runBulkPeriodAction', () => {
  it('locks every valid id up front in ONE ordered statement, and never sends a non-uuid', async () => {
    await runBulkPeriodAction(C, 'bulk_close', [MAR, 'not-a-uuid', JAN, FEB], 'u1');
    expect(h.queries).toHaveLength(1);
    expect(h.queries[0]!.text).toMatch(/AND id = ANY\(\?::UUID\[\]\) ORDER BY fiscal_year, period_number, id FOR NO KEY UPDATE$/);
    expect(h.queries[0]!.values).toEqual([C, [MAR, JAN, FEB]]);
  });

  it('closes in period order, not click order, each in its own savepoint, sharing one check memo', async () => {
    await runBulkPeriodAction(C, 'bulk_close', [MAR, FEB, JAN], 'u1');
    expect(vi.mocked(closePeriodWithVerdict).mock.calls.map((c) => c[1])).toEqual([JAN, FEB, MAR]);
    expect(h.savepoints).toEqual(['fp_bulk_0', 'fp_bulk_1', 'fp_bulk_2']);
    const memos = vi.mocked(closePeriodWithVerdict).mock.calls.map((c) => c[3]);
    expect(memos[0]).toBeDefined();
    expect(memos.every((m) => m === memos[0])).toBe(true);
  });

  it('a refusal is that period\'s row and the rest go on; results come back in the caller\'s order', async () => {
    h.locked = [JAN, FEB];
    vi.mocked(closePeriodWithVerdict)
      .mockRejectedValueOnce(new PeriodCloseBlockedError('January 2026', [BANK], [BANK], JAN))
      .mockRejectedValueOnce(new PeriodNotCloseableError('February 2026 cannot be closed: prior periods are still open (January 2026). Close them first.'));
    const out = await runBulkPeriodAction(C, 'bulk_close', [FEB, JAN, OTHER_CO], 'u1');
    expect(out).toEqual({
      okCount: 0, total: 3,
      results: [
        { id: FEB, ok: false, error: expect.stringMatching(/prior periods are still open \(January 2026\)/) },
        { id: JAN, ok: false, error: expect.stringMatching(/^January 2026 cannot be closed/), code: 'PERIOD_CLOSE_NOT_READY',
          periods: [{ periodId: JAN, periodName: 'January 2026', blockers: [{ key: BANK.key, label: BANK.label, reason: BANK.reason, fixHref: BANK.fixHref }] }] },
        { id: OTHER_CO, ok: false, error: 'Fiscal period not found' },
      ],
    });
  });

  it.each([
    ['a period lock wait that ran out', new FiscalPeriodLockTimeoutError()],
    ['a deadlock (40P01)', Object.assign(new Error('deadlock detected'), { code: '40P01' })],
    ['an aborted transaction (25P02)', Object.assign(new Error('current transaction is aborted'), { code: '25P02' })],
    ['a lock_timeout (55P03)', Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' })],
  ])('%s fails the whole request: never an ok:true row for a write that rolls back', async (_n, err) => {
    vi.mocked(closePeriodWithVerdict).mockResolvedValueOnce({} as never).mockRejectedValueOnce(err);
    await expect(runBulkPeriodAction(C, 'bulk_close', [JAN, FEB, MAR], 'u1')).rejects.toBe(err);
    expect(closePeriodWithVerdict).toHaveBeenCalledTimes(2);
  });

  it('Bulk Lock goes through lockPeriod (the gated lock) with the shared memo', async () => {
    await runBulkPeriodAction(C, 'bulk_lock', [JAN], 'u1');
    expect(lockPeriod).toHaveBeenCalledTimes(3);
    expect(vi.mocked(lockPeriod).mock.calls[0]![2]).toBeDefined();
  });
});
