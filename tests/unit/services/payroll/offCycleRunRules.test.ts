/**
 * Wave 6 OC: the rules an off-cycle run is held to before any write (payrollOffCycleRun, payrollOffCycleGates) and
 * the journal it posts (payrollJournalDescription). Carried item 2 (review #1549 delta-2 D1): an off-cycle run is never
 * approved after its pay date.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => []), withTransaction: vi.fn() }));

import { judgeOffCycleShape, OffCycleRunRefusedError, type OffCycleRunInput } from '@/modules/accounting/services/payroll/payrollOffCycleRun';
import { offCyclePayDateRefusal } from '@/modules/accounting/services/payroll/payrollOffCycleGates';
import { runJournalDescriptionOf } from '@/modules/accounting/services/payroll/payrollJournalDescription';
import { lastOffCyclePayDay } from '@/components/payroll/offCycle/useOffCycleSources';

const E1 = '11111111-1111-4111-8111-111111111111';
const E2 = '22222222-2222-4222-8222-222222222222';
const C1 = '33333333-3333-4333-8333-333333333333';
const TODAY = '2026-11-17';
const bonus = (over: Partial<OffCycleRunInput> = {}): OffCycleRunInput => ({
  period: { year: 2026, month: 11 }, reason: 'bonus', runDate: '2026-11-27',
  employees: [{ employeeId: E1, componentId: C1, amount: 5_000 }], ...over,
});
const refused = (input: OffCycleRunInput): string => {
  try {
    judgeOffCycleShape(input, TODAY);
  } catch (err) {
    expect(err).toBeInstanceOf(OffCycleRunRefusedError);
    expect((err as OffCycleRunRefusedError).status).toBe(400);
    return (err as Error).message;
  }
  throw new Error('not refused');
};

describe('the request shape', () => {
  it('a bonus on a pay date in the month, today or later, passes', () => {
    expect(() => judgeOffCycleShape(bonus(), TODAY)).not.toThrow();
    expect(() => judgeOffCycleShape(bonus({ runDate: TODAY }), TODAY)).not.toThrow();
    expect(() => judgeOffCycleShape(bonus({ reason: 'termination', employees: [{ employeeId: E1 }] }), TODAY)).not.toThrow();
  });
  it('the pay date: a real day, in the run\'s month, not in the past', () => {
    expect(refused(bonus({ runDate: '2026-11-31' }))).toMatch(/date/);
    expect(refused(bonus({ runDate: '2026-12-01' }))).toMatch(/must be in 2026-11/);
    expect(refused(bonus({ runDate: '2026-11-16' }))).toMatch(/has passed/);
  });
  it('the reason, the employees and the amounts', () => {
    expect(refused(bonus({ reason: 'leave' as never }))).toMatch(/reason/);
    expect(refused(bonus({ employees: [] }))).toMatch(/at least one/);
    expect(refused(bonus({ employees: [{ employeeId: E1, componentId: C1, amount: 1 }, { employeeId: E1, componentId: C1, amount: 2 }] }))).toMatch(/twice/);
    expect(refused(bonus({ employees: [{ employeeId: 'x', componentId: C1, amount: 1 }] }))).toMatch(/employeeId/);
    expect(refused(bonus({ employees: [{ employeeId: E1, amount: 1 }] }))).toMatch(/annual-payment component/);
    for (const amount of [0, -5, 1.005, Number.NaN, 200_000_000]) {
      expect(refused(bonus({ employees: [{ employeeId: E1, componentId: C1, amount }] }))).toMatch(/more than nil, in rand and cents/);
    }
    expect(refused(bonus({ reason: 'termination', employees: [{ employeeId: E2, componentId: C1, amount: 10 }] }))).toMatch(/takes no amounts/);
  });
});

describe('approval: never after the pay date (carried item 2)', () => {
  it('refuses an off-cycle run whose pay date is before the approval day', () => {
    expect(offCyclePayDateRefusal({ run_kind: 'off_cycle', run_date: '2026-11-16' }, TODAY)).toMatch(/before today/);
    expect(offCyclePayDateRefusal({ run_kind: 'off_cycle', run_date: null }, TODAY)).toMatch(/no pay date/);
  });
  it('approves on or before the pay date, and never judges a regular run', () => {
    expect(offCyclePayDateRefusal({ run_kind: 'off_cycle', run_date: TODAY }, TODAY)).toBeNull();
    expect(offCyclePayDateRefusal({ run_kind: 'off_cycle', run_date: '2026-11-28' }, TODAY)).toBeNull();
    expect(offCyclePayDateRefusal({ run_kind: 'regular', run_date: '2020-01-01' }, TODAY)).toBeNull();
  });
});

describe('the journal names the off-cycle kind (FQc\'s run-keyed description, adopted by OC)', () => {
  const hdr = (over: Record<string, unknown>) => ({ period_year: 2026, period_month: 11, pay_frequency: 'monthly', run_kind: 'regular',
    off_cycle_reason: null, run_date: null, period_end: '2026-11-30', ...over });
  it('a regular run is unchanged; an off-cycle run carries its reason and pay date', () => {
    expect(runJournalDescriptionOf(hdr({}))).toBe('Payroll run 2026-11');
    expect(runJournalDescriptionOf(hdr({ run_kind: 'off_cycle', off_cycle_reason: 'bonus', run_date: '2026-11-28' })))
      .toBe('Payroll run 2026-11 bonus, paid 2026-11-28');
    expect(runJournalDescriptionOf(hdr({ run_kind: 'off_cycle', off_cycle_reason: 'termination', run_date: '2026-11-20' })))
      .toBe('Payroll run 2026-11 termination, paid 2026-11-20');
  });
});

describe('the form\'s last pay day: the day before the regular run\'s pay date (review #1575 carry 1)', () => {
  it('reads run_date, else period_end, else the month end', () => {
    expect(lastOffCyclePayDay({ id: 'r', periodYear: 2026, periodMonth: 11, runDate: '2026-11-25', periodEnd: '2026-11-30' })).toBe('2026-11-24');
    expect(lastOffCyclePayDay({ id: 'r', periodYear: 2026, periodMonth: 11, runDate: null, periodEnd: '2026-11-30' })).toBe('2026-11-29');
    expect(lastOffCyclePayDay({ id: 'r', periodYear: 2027, periodMonth: 3, runDate: null, periodEnd: null })).toBe('2027-03-30');
  });
});
