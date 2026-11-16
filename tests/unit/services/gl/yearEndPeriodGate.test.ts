/**
 * The year-end close's period lock (B1 / B2, 2026-11-15): inside the write
 * transaction it locks the year's rows in (fiscal_year, period_number, id)
 * order, re-reads their status (anything not closed or locked, NULL included,
 * refuses), runs the readiness gate on every period it will lock, and updates
 * only the judged `closed` rows, checking the count.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/modules/accounting/services/gl/periodCloseGate', () => ({ assertYearCloseReady: vi.fn(async () => undefined) }));

import { assertYearCloseReady } from '@/modules/accounting/services/gl/periodCloseGate';
import { YearCloseBlockedError } from '@/modules/accounting/services/gl/periodCloseErrors';
import {
  lockAndJudgeYear, lockYear, YearEndPeriodsNotClosedError,
} from '@/modules/accounting/services/gl/yearEndPeriodGate';

const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
let queries: Array<{ text: string; values: unknown[] }> = [];
let answer: (text: string) => unknown[] = () => [];
const tx = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
  const text = strings.join('?').replace(/\s+/g, ' ').trim();
  queries.push({ text, values });
  return answer(text);
}) as unknown as Parameters<typeof lockAndJudgeYear>[0];

const p = (id: string, n: number, status: string | null) => ({ id, period_name: `P${n}`, period_number: n, status });

beforeEach(() => { vi.clearAllMocks(); queries = []; });

describe('lockAndJudgeYear', () => {
  it('locks the year in (fiscal_year, period_number, id) order and gates every closed period as a LOCK', async () => {
    answer = () => [p('a', 1, 'closed'), p('b', 2, 'locked'), p('c', 3, 'closed')];
    expect(await lockAndJudgeYear(tx, C, '2026')).toEqual(['a', 'c']);
    expect(queries[0]!.text).toMatch(/ORDER BY fiscal_year, period_number, id FOR NO KEY UPDATE$/);
    expect(assertYearCloseReady).toHaveBeenCalledWith(C, 2026,
      [{ id: 'a', periodName: 'P1' }, { id: 'c', periodName: 'P3' }], {}, 'locked');
  });

  it.each([['closing'], ['open'], [null]])('a period in status %s refuses the close, named, before the checks', async (status) => {
    answer = () => [p('a', 1, 'closed'), p('b', 2, status)];
    const err = await lockAndJudgeYear(tx, C, '2026').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(YearEndPeriodsNotClosedError);
    expect((err as YearEndPeriodsNotClosedError).openPeriods).toEqual([{ id: 'b', periodName: 'P2', periodNumber: 2 }]);
    expect(assertYearCloseReady).not.toHaveBeenCalled();
  });

  it('a failing check refuses with the gate\'s error, and nothing is written', async () => {
    answer = () => [p('a', 1, 'closed')];
    const refusal = new YearCloseBlockedError(2026, [{ periodId: 'a', periodName: 'P1', blockers: [] }], 'locked');
    vi.mocked(assertYearCloseReady).mockRejectedValueOnce(refusal);
    await expect(lockAndJudgeYear(tx, C, '2026')).rejects.toBe(refusal);
    expect(queries.filter((q) => /^UPDATE/.test(q.text))).toEqual([]);
  });
});

describe('lockYear', () => {
  it('updates only the judged rows that are still closed, and reports the year\'s locked count', async () => {
    answer = (t) => (/^UPDATE/.test(t) ? [{ id: 'a' }, { id: 'c' }] : [{ n: 12 }]);
    expect(await lockYear(tx, C, '2026', ['a', 'c'])).toBe(12);
    const update = queries[0]!;
    expect(update.text).toMatch(/AND status = 'closed' AND id = ANY\(\?::UUID\[\]\)/);
    expect(update.values).toContainEqual(['a', 'c']);
  });

  it('throws (so the transaction rolls back) when fewer rows locked than were judged', async () => {
    answer = (t) => (/^UPDATE/.test(t) ? [{ id: 'a' }] : [{ n: 12 }]);
    await expect(lockYear(tx, C, '2026', ['a', 'c'])).rejects.toThrow(/2 periods were judged but 1 were locked/);
  });
});
