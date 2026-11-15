/**
 * The app's own close paths go through the readiness gate (Hein, 2026-11-15):
 * `closePeriod` (single Close and Bulk Close) and `closeYear` (Close Year) lock
 * the period rows, run the gate, and only then write. A refusal writes nothing.
 * `closeYear` is all-or-nothing, like its single UPDATE: it hands the gate every
 * period it would close. Reopen is not gated.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ queries: [] as string[], rows: [] as Array<Record<string, unknown>> }));

vi.mock('@/lib/neon', () => ({
  sql: vi.fn(async (strings: TemplateStringsArray) => {
    const text = strings.join('?').replace(/\s+/g, ' ').trim();
    h.queries.push(text);
    if (/COUNT\(\*\) AS cnt/.test(text)) return [{ cnt: 0 }];
    if (/^UPDATE fiscal_periods/.test(text)) {
      if (/SET status = 'open'/.test(text)) return h.rows.map((r) => ({ ...r, status: 'open' }));
      return h.rows.filter((r) => r.status !== 'closed' && r.status !== 'locked').map((r) => ({ ...r, status: 'closed' }));
    }
    return h.rows;
  }),
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/auth/impersonationGuard', () => ({ assertNotImpersonating: vi.fn(async () => undefined) }));
vi.mock('@/modules/accounting/services/audit/autoSnapshotQueue', () => ({ scheduleAutoSnapshot: vi.fn() }));
vi.mock('@/modules/accounting/services/budgets/drivers/budgetRollQueue', () => ({ scheduleBudgetRoll: vi.fn() }));
vi.mock('@/modules/accounting/services/gl/periodCloseGate', () => ({
  assertPeriodCloseReady: vi.fn(async () => { h.queries.push('GATE'); }),
  assertYearCloseReady: vi.fn(async () => { h.queries.push('GATE'); }),
}));

import { assertPeriodCloseReady, assertYearCloseReady } from '@/modules/accounting/services/gl/periodCloseGate';
import { PeriodCloseBlockedError, YearCloseBlockedError } from '@/modules/accounting/services/gl/periodCloseErrors';
import { closePeriod, closeYear, reopenPeriod } from '@/modules/accounting/services/gl/fiscalPeriodService';

const COMPANY = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function row(id: string, n: number, status: string) {
  const mm = String(n).padStart(2, '0');
  return {
    id, period_name: `P${n}`, period_number: n, fiscal_year: 2026, start_date: `2026-${mm}-01`,
    end_date: `2026-${mm}-28`, status, closed_by: null, closed_at: null, created_at: 'x', updated_at: 'x',
  };
}

const writes = () => h.queries.filter((q) => /^UPDATE fiscal_periods/.test(q));
const blocked = () => new PeriodCloseBlockedError('P1', [
  { key: 'bank_reconciled', label: 'Bank reconciled', status: 'fail', reason: '1 unreconciled', fixHref: '/accounting/bank-transactions' },
], [], 'p1');

beforeEach(() => {
  vi.clearAllMocks();
  h.queries = [];
  h.rows = [row('p1', 1, 'open')];
});

describe('closePeriod', () => {
  it('locks the period row before judging it, then gates, then writes', async () => {
    await closePeriod(COMPANY, 'p1', 'u1');
    expect(h.queries[0]).toMatch(/FROM fiscal_periods WHERE id = \? AND company_id = \? FOR NO KEY UPDATE/);
    expect(assertPeriodCloseReady).toHaveBeenCalledWith(COMPANY, 'p1');
    expect(writes()).toHaveLength(1);
    expect(h.queries.slice(-2)).toEqual(['GATE', writes()[0]]);
  });

  it('refuses when the gate refuses, and writes nothing', async () => {
    vi.mocked(assertPeriodCloseReady).mockRejectedValueOnce(blocked());
    await expect(closePeriod(COMPANY, 'p1', 'u1')).rejects.toBeInstanceOf(PeriodCloseBlockedError);
    expect(writes()).toEqual([]);
  });

  it('refuses a locked or closed period before running the checks', async () => {
    h.rows = [row('p1', 1, 'closed')];
    await expect(closePeriod(COMPANY, 'p1', 'u1')).rejects.toThrow('Period is already closed');
    expect(assertPeriodCloseReady).not.toHaveBeenCalled();
  });
});

describe('closeYear', () => {
  beforeEach(() => {
    h.rows = [row('p1', 1, 'closed'), row('p2', 2, 'open'), row('p3', 3, 'closing'), row('p4', 4, 'locked')];
  });

  it("locks the year's periods in period order and gates every period it would close", async () => {
    await closeYear(COMPANY, 2026, 'u1');
    expect(h.queries[0]).toMatch(/FROM fiscal_periods WHERE company_id = \? AND fiscal_year = \? ORDER BY period_number FOR NO KEY UPDATE/);
    expect(assertYearCloseReady).toHaveBeenCalledTimes(1);
    const [company, year, periods] = vi.mocked(assertYearCloseReady).mock.calls[0]!;
    expect([company, year]).toEqual([COMPANY, 2026]);
    expect(periods.map((p) => p.id)).toEqual(['p2', 'p3']);
    expect(writes()).toHaveLength(1);
    expect(h.queries.slice(-2)).toEqual(['GATE', writes()[0]]);
  });

  it('is all or nothing: one blocked period refuses the year and nothing is written', async () => {
    vi.mocked(assertYearCloseReady).mockRejectedValueOnce(new YearCloseBlockedError(2026, [
      { periodId: 'p3', periodName: 'P3', blockers: [] },
    ]));
    await expect(closeYear(COMPANY, 2026, 'u1')).rejects.toBeInstanceOf(YearCloseBlockedError);
    expect(writes()).toEqual([]);
  });
});

describe('reopenPeriod', () => {
  it('is not gated', async () => {
    h.rows = [row('p1', 1, 'closed')];
    await reopenPeriod(COMPANY, 'p1');
    expect(assertPeriodCloseReady).not.toHaveBeenCalled();
    expect(assertYearCloseReady).not.toHaveBeenCalled();
    expect(writes()).toHaveLength(1);
  });
});
