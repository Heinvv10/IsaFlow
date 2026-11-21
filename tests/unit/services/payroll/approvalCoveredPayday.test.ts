/**
 * Gate item 1 on 06c106a94d: an off-cycle run is approved after its pay date only as a correction of a run that was
 * approved OVER the start of its payday (SAST): some approval_history interval covers that instant. Approved on 10 Nov
 * for a 20 Nov payday, reopened on 12 Nov and approved again on 21 Nov was never approved over payday: refused. The same
 * predicate is the cash forecast's "disbursed" (approvalCoveredPaydaySql).
 */
import { describe, expect, it } from 'vitest';
import { approvalCoveredPayday } from '@/modules/accounting/services/payroll/payrollPaydayCover';
import { offCyclePayDateRefusal } from '@/modules/accounting/services/payroll/payrollOffCycleGates';

const run = (history: string | null) => ({ run_kind: 'off_cycle', run_date: '2026-11-20', approval_history: history });

describe('approvalCoveredPayday', () => {
  it('true only when an interval covers the start of payday (00:00 SAST)', () => {
    expect(approvalCoveredPayday('{["2026-11-10 08:00:00+00","2026-11-12 08:00:00+00")}', '2026-11-20')).toBe(false);
    expect(approvalCoveredPayday('{["2026-11-10 08:00:00+00","2026-11-25 08:00:00+00")}', '2026-11-20')).toBe(true);
    // From 00:00 SAST (22:00 UTC the day before) exactly, inclusive; an approval from the day after is not.
    expect(approvalCoveredPayday('{["2026-11-19 22:00:00+00","2026-11-25 08:00:00+00")}', '2026-11-20')).toBe(true);
    expect(approvalCoveredPayday('{["2026-11-21 08:00:00+00","2026-11-25 08:00:00+00")}', '2026-11-20')).toBe(false);
    // Two intervals, the second covers; a grandfathered (unbounded below) one covers too.
    expect(approvalCoveredPayday('{["2026-11-01 08:00:00+00","2026-11-02 08:00:00+00"),["2026-11-18 08:00:00+00","2026-11-22 08:00:00+00")}', '2026-11-20')).toBe(true);
    expect(approvalCoveredPayday('{(,"2026-11-22 08:00:00+00")}', '2026-11-20')).toBe(true);
    expect(approvalCoveredPayday(null, '2026-11-20')).toBe(false);
    expect(approvalCoveredPayday('{}', '2026-11-20')).toBe(false);
    // pg's own text form in a SAST session, with microseconds.
    expect(approvalCoveredPayday('{["2026-11-19 10:00:00.123456+02","2026-11-21 10:00:00.5+02")}', '2026-11-20')).toBe(true);
  });
});

describe('offCyclePayDateRefusal after payday', () => {
  it('approved 10 Nov, reopened 12 Nov, approved again 21 Nov for a 20 Nov payday: refused', () => {
    expect(offCyclePayDateRefusal(run('{["2026-11-10 08:00:00+00","2026-11-12 08:00:00+00")}'), '2026-11-21')).toMatch(/before today/);
  });
  it('approved over payday and reopened after it: the correction is allowed', () => {
    expect(offCyclePayDateRefusal(run('{["2026-11-10 08:00:00+00","2026-11-22 08:00:00+00")}'), '2026-11-23')).toBeNull();
  });
});
