/**
 * The status writers (fiscalPeriodCloseWrites) go through the readiness gate
 * (Hein, 2026-11-15): close (single, Bulk, MCP), Close Year and Lock lock the
 * period rows in (fiscal_year, period_number, id) order, re-read the status
 * from the locked row, run the gate, and only then write. A refusal writes
 * nothing. Close Year is all or nothing. Reopen is not gated.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  queries: [] as Array<{ text: string; values: unknown[] }>,
  rows: [] as Array<Record<string, unknown>>,
  prior: [] as Array<Record<string, unknown>>,
}));

vi.mock('@/lib/neon', () => ({
  sql: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?').replace(/\s+/g, ' ').trim();
    h.queries.push({ text, values });
    if (/period_number < \?/.test(text)) return h.prior;
    if (/^UPDATE fiscal_periods/.test(text)) {
      const status = /SET status = 'open'/.test(text) ? 'open' : /SET status = 'locked'/.test(text) ? 'locked' : 'closed';
      return h.rows.map((r) => ({ ...r, status }));
    }
    return h.rows;
  }),
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/auth/impersonationGuard', () => ({ assertNotImpersonating: vi.fn(async () => undefined) }));
vi.mock('@/modules/accounting/services/audit/autoSnapshotQueue', () => ({ scheduleAutoSnapshot: vi.fn() }));
vi.mock('@/modules/accounting/services/budgets/drivers/budgetRollQueue', () => ({ scheduleBudgetRoll: vi.fn() }));
vi.mock('@/modules/accounting/services/gl/periodCloseGate', () => ({
  assertPeriodCloseReady: vi.fn(async () => { h.queries.push({ text: 'GATE', values: [] }); return { items: [] }; }),
  assertYearCloseReady: vi.fn(async () => { h.queries.push({ text: 'GATE', values: [] }); }),
  withPeriodLockBudget: (fn: () => Promise<unknown>) => fn(),
}));

import { assertPeriodCloseReady, assertYearCloseReady } from '@/modules/accounting/services/gl/periodCloseGate';
import {
  PeriodCloseBlockedError, PeriodNotCloseableError, YearCloseBlockedError,
} from '@/modules/accounting/services/gl/periodCloseErrors';
import {
  closePeriod, closeYear, judgePeriodClose, lockPeriod, reopenPeriod,
} from '@/modules/accounting/services/gl/fiscalPeriodService';

const COMPANY = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const P1 = '11111111-1111-4111-8111-111111111111';

function row(id: string, n: number, status: string | null) {
  const mm = String(n).padStart(2, '0');
  return {
    id, period_name: `P${n}`, period_number: n, fiscal_year: 2026, start_date: `2026-${mm}-01`,
    end_date: `2026-${mm}-28`, status, closed_by: null, closed_at: null, created_at: 'x', updated_at: 'x',
  };
}

const texts = () => h.queries.map((q) => q.text);
const writes = () => texts().filter((t) => /^UPDATE fiscal_periods/.test(t));
const blocked = () => new PeriodCloseBlockedError('P1', [
  { key: 'bank_reconciled', label: 'Bank reconciled', status: 'fail', reason: '1 unreconciled', fixHref: '/accounting/bank-transactions' },
], [], P1);

beforeEach(() => {
  vi.clearAllMocks();
  h.queries = [];
  h.prior = [];
  h.rows = [row(P1, 1, 'open')];
});

describe('closePeriod', () => {
  it('locks the period row before judging it, then gates, then writes', async () => {
    await closePeriod(COMPANY, P1, 'u1');
    expect(texts()[0]).toMatch(/FROM fiscal_periods WHERE id = \?::UUID AND company_id = \?::UUID FOR NO KEY UPDATE/);
    expect(assertPeriodCloseReady).toHaveBeenCalledWith(COMPANY, P1, undefined);
    expect(writes()).toHaveLength(1);
    expect(texts().slice(-2)).toEqual(['GATE', writes()[0]]);
  });

  it('refuses when the gate refuses, and writes nothing', async () => {
    vi.mocked(assertPeriodCloseReady).mockRejectedValueOnce(blocked());
    await expect(closePeriod(COMPANY, P1, 'u1')).rejects.toBeInstanceOf(PeriodCloseBlockedError);
    expect(writes()).toEqual([]);
  });

  it('refuses a closed period from the LOCKED row, before the checks', async () => {
    h.rows = [row(P1, 1, 'closed')];
    await expect(closePeriod(COMPANY, P1, 'u1')).rejects.toThrow(new PeriodNotCloseableError('P1 is already closed'));
    expect(assertPeriodCloseReady).not.toHaveBeenCalled();
  });

  it('names the open prior periods with a typed refusal, before the checks, and writes nothing', async () => {
    h.prior = [{ period_name: 'January 2026' }, { period_name: 'February 2026' }];
    const err = await closePeriod(COMPANY, P1, 'u1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PeriodNotCloseableError);
    expect((err as Error).message).toBe('P1 cannot be closed: prior periods are still open (January 2026, February 2026). Close them first.');
    const priorQuery = texts().find((t) => /period_number < \?/.test(t))!;
    expect(priorQuery).toMatch(/status IS DISTINCT FROM 'closed' AND status IS DISTINCT FROM 'locked'/);
    expect(assertPeriodCloseReady).not.toHaveBeenCalled();
    expect(writes()).toEqual([]);
  });

  it('an id that is not a uuid is not found, and reaches no SQL', async () => {
    await expect(closePeriod(COMPANY, 'abc', 'u1')).rejects.toThrow(new PeriodNotCloseableError('Fiscal period not found'));
    expect(h.queries).toEqual([]);
  });
});

describe('judgePeriodClose (the MCP dry run)', () => {
  it('runs the lock, the guards and the gate, and writes nothing', async () => {
    const out = await judgePeriodClose(COMPANY, P1);
    expect(out.period.id).toBe(P1);
    expect(texts()[0]).toMatch(/FOR NO KEY UPDATE/);
    expect(texts()).toContain('GATE');
    expect(writes()).toEqual([]);
  });
});

describe('lockPeriod', () => {
  beforeEach(() => { h.rows = [row(P1, 1, 'closed')]; });

  it('judges a closed period again before locking it, and locks only a closed row', async () => {
    await lockPeriod(COMPANY, P1);
    expect(texts()[0]).toMatch(/FOR NO KEY UPDATE/);
    expect(assertPeriodCloseReady).toHaveBeenCalledWith(COMPANY, P1, undefined, 'locked');
    expect(texts().slice(-2)).toEqual(['GATE', writes()[0]]);
    expect(writes()[0]).toMatch(/SET status = 'locked' WHERE id = \?::UUID AND company_id = \?::UUID AND status = 'closed'/);
  });

  it('refuses when the gate refuses, and writes nothing', async () => {
    vi.mocked(assertPeriodCloseReady).mockRejectedValueOnce(blocked());
    await expect(lockPeriod(COMPANY, P1)).rejects.toBeInstanceOf(PeriodCloseBlockedError);
    expect(writes()).toEqual([]);
  });

  it('refuses an open period before the checks', async () => {
    h.rows = [row(P1, 1, 'open')];
    await expect(lockPeriod(COMPANY, P1)).rejects.toThrow(new PeriodNotCloseableError('Period must be closed before locking'));
    expect(assertPeriodCloseReady).not.toHaveBeenCalled();
  });
});

describe('closeYear', () => {
  const ids = ['a1111111-1111-4111-8111-111111111111', 'a2222222-2222-4222-8222-222222222222',
    'a3333333-3333-4333-8333-333333333333', 'a4444444-4444-4444-8444-444444444444', 'a5555555-5555-4555-8555-555555555555'];
  beforeEach(() => {
    h.rows = [row(ids[0]!, 1, 'closed'), row(ids[1]!, 2, 'open'), row(ids[2]!, 3, 'closing'),
      row(ids[3]!, 4, 'locked'), row(ids[4]!, 5, null)];
  });

  it("locks the year's periods in (fiscal_year, period_number, id) order and gates every unsettled one", async () => {
    await closeYear(COMPANY, 2026, 'u1');
    expect(texts()[0]).toMatch(/AND fiscal_year = \? ORDER BY fiscal_year, period_number, id FOR NO KEY UPDATE/);
    const [company, year, periods] = vi.mocked(assertYearCloseReady).mock.calls[0]!;
    expect([company, year]).toEqual([COMPANY, 2026]);
    expect(periods.map((p) => p.id)).toEqual([ids[1], ids[2], ids[4]]); // open, closing and a NULL status
    expect(texts().slice(-2)).toEqual(['GATE', writes()[0]]);
    const update = h.queries.find((q) => /^UPDATE/.test(q.text))!;
    expect(update.text).toMatch(/AND id = ANY\(\?::UUID\[\]\)/);
    expect(update.values).toContainEqual([ids[1], ids[2], ids[4]]);
  });

  it('is all or nothing: one blocked period refuses the year and nothing is written', async () => {
    vi.mocked(assertYearCloseReady).mockRejectedValueOnce(new YearCloseBlockedError(2026, [
      { periodId: ids[2]!, periodName: 'P3', blockers: [] },
    ]));
    await expect(closeYear(COMPANY, 2026, 'u1')).rejects.toBeInstanceOf(YearCloseBlockedError);
    expect(writes()).toEqual([]);
  });

  it('a year whose periods are all closed or locked is refused as already closed, ungated', async () => {
    h.rows = [row(ids[0]!, 1, 'closed'), row(ids[3]!, 4, 'locked')];
    await expect(closeYear(COMPANY, 2026, 'u1')).rejects.toThrow(new PeriodNotCloseableError('Fiscal year 2026 is already closed'));
    expect(assertYearCloseReady).not.toHaveBeenCalled();
    expect(writes()).toEqual([]);
  });
});

describe('reopenPeriod', () => {
  it('takes the row lock (so it waits for a close in flight) and is not gated', async () => {
    h.rows = [row(P1, 1, 'closed')];
    await reopenPeriod(COMPANY, P1);
    expect(texts()[0]).toMatch(/FOR NO KEY UPDATE/);
    expect(assertPeriodCloseReady).not.toHaveBeenCalled();
    expect(assertYearCloseReady).not.toHaveBeenCalled();
    expect(writes()).toHaveLength(1);
  });
});
