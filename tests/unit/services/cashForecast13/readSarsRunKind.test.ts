/**
 * Wave 6 EF (ledger review round 2): a month whose EMP201 the run-kind guard refuses (RunKindUnsupportedError) is a
 * source_unavailable warning carrying the guard's message; the 13-week forecast still resolves. Any other error from
 * the EMP201 read still propagates (guardedSource's allow-list).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const st = vi.hoisted(() => ({ fail: 'runKind' as 'runKind' | 'bug' }));

vi.mock('@/lib/neon', () => ({ sql: Object.assign(vi.fn(), { unsafe: vi.fn() }), withSavepoint: (_n: string, f: () => unknown) => f() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/modules/accounting/services/reports/emp201Service', () => ({
  generateEMP201: vi.fn(async () => {
    if (st.fail === 'bug') throw new TypeError('a code bug');
    const { RunKindUnsupportedError } = await import('@/modules/accounting/services/payroll/payrollRunKindGuard');
    throw new RunKindUnsupportedError('emp201', [{ clause: 'frequency', detail: 'it is a weekly run, and only monthly runs are supported' }]);
  }),
}));
vi.mock('@/modules/accounting/services/reports/sarsComplianceCalendarDb', () => ({
  getComplianceCalendarWithMarks: vi.fn(async () => ({ marksUnavailable: false, submissionsUnavailable: false, events: [
    { eventType: 'EMP201_DUE', periodStart: '2026-10-01', periodEnd: '2026-10-31', dueDate: '2026-11-20', status: 'pending', description: 'EMP201 Oct' },
  ] })),
}));

import { sarsItems } from '@/modules/accounting/services/cashForecast13/readSars';
import type { ForecastWarning } from '@/modules/accounting/services/cashForecast13/types';

const payroll = { latest: { period: '2026-11', statutoryCents: 100 } } as never;
beforeEach(() => { st.fail = 'runKind'; });

describe('cash forecast: a refused EMP201 month', () => {
  it('degrades to source_unavailable with the guard\'s message; the forecast resolves with no EMP201 line', async () => {
    const warnings: ForecastWarning[] = [];
    const items = await sarsItems('c', '2026-11-17', '2027-02-15', payroll, null, warnings);
    expect(items).toEqual([]);
    const w = warnings.find((x) => x.code === 'source_unavailable')!;
    expect(w.source).toBe('EMP201 2026-10');
    expect(w.message).toContain('weekly run');
  });
  it('any other error still propagates (a code bug is not a missing source)', async () => {
    st.fail = 'bug';
    await expect(sarsItems('c', '2026-11-17', '2027-02-15', payroll, null, [])).rejects.toThrow('a code bug');
  });
});
