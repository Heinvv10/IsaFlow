/**
 * Review #1679 (ruling on paidCaps): the TypeScript cap reads the payday the 999x trigger froze at the run's first
 * approval (off_cycle_payday_at), as the snapshot trigger does, never run_date, which a statement could once move.
 * No frozen payday with an approval history fails closed (every employee capped at nil); with none, nothing is capped.
 */
import { describe, expect, it } from 'vitest';
import { offCycleRaiseRefusal } from '@/modules/accounting/services/payroll/payrollOffCycleCorrection';

const EMP = '11111111-1111-4111-8111-111111111111';
// Pay date 18 Nov 2026: payday ends at 19 Nov 00:00 SAST (22:00 UTC on the 18th).
const run = (over: Record<string, unknown>) => ({
  id: 'r', run_kind: 'off_cycle', run_date: '2026-11-18', off_cycle_payday_at: '2026-11-18T22:00:00.000Z',
  off_cycle_paid_gross: { [EMP]: 200 }, approval_history: '{["2026-11-10 08:00:00+00","2026-11-20 08:00:00+00")}', ...over,
});

describe('paidCaps reads the frozen payday', () => {
  it('a run_date moved later does not lift the cap: paid on the 18th, R250 refused on the 21st', () => {
    expect(offCycleRaiseRefusal(run({ run_date: '2026-12-30' }), EMP, 250, '2026-11-21')).toMatch(/can't be raised after the pay date/);
    expect(offCycleRaiseRefusal(run({ run_date: '2026-12-30' }), EMP, 180, '2026-11-21')).toBeNull();
    // The day after the pay date is past payday (paid at the end of the 18th, SAST).
    expect(offCycleRaiseRefusal(run({}), EMP, 250, '2026-11-19')).toMatch(/paid on 18/);
  });
  it('before the frozen payday has passed nothing is capped, whatever run_date says', () => {
    expect(offCycleRaiseRefusal(run({ run_date: '2026-11-01' }), EMP, 999, '2026-11-18')).toBeNull();
  });
  it('no frozen payday with an approval history: every employee at nil; without one: no cap', () => {
    expect(offCycleRaiseRefusal(run({ off_cycle_payday_at: null }), EMP, 1, '2026-11-21')).toMatch(/last approved R\s0\.00/);
    expect(offCycleRaiseRefusal(run({ off_cycle_payday_at: null, approval_history: null }), EMP, 999, '2026-11-21')).toBeNull();
  });
});
