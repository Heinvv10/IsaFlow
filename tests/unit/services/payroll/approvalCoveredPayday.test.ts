/**
 * Gate item 1 on 06c106a94d: an off-cycle run is approved after its pay date only as a correction of a run that was
 * approved THROUGH its payday (SAST): some approval_history interval covers payday's end (00:00 the next day). Approved on 10 Nov
 * for a 20 Nov payday, reopened on 12 Nov and approved again on 21 Nov was never approved over payday: refused. The same
 * predicate is the cash forecast's "disbursed" (approvalCoveredPaydaySql).
 */
import { describe, expect, it } from 'vitest';
import { approvalCoveredPayday } from '@/modules/accounting/services/payroll/payrollPaydayCover';
import { offCyclePayDateRefusal } from '@/modules/accounting/services/payroll/payrollOffCycleGates';

const run = (history: string | null) => ({ run_kind: 'off_cycle', run_date: '2026-11-20', approval_history: history });

describe('approvalCoveredPayday', () => {
  it('true only when an interval covers the end of payday (00:00 SAST the next day)', () => {
    expect(approvalCoveredPayday('{["2026-11-10 08:00:00+00","2026-11-12 08:00:00+00")}', '2026-11-20')).toBe(false);
    expect(approvalCoveredPayday('{["2026-11-10 08:00:00+00","2026-11-25 08:00:00+00")}', '2026-11-20')).toBe(true);
    // Approved on the pay date itself and reopened after it: disbursed. From 00:00 SAST the next day (22:00 UTC on the
    // pay date) exactly, inclusive; an approval from after it, or one reopened before it, is not.
    expect(approvalCoveredPayday('{["2026-11-20 08:00:00+00","2026-11-25 08:00:00+00")}', '2026-11-20')).toBe(true);
    expect(approvalCoveredPayday('{["2026-11-20 22:00:00+00","2026-11-25 08:00:00+00")}', '2026-11-20')).toBe(true);
    expect(approvalCoveredPayday('{["2026-11-21 08:00:00+00","2026-11-25 08:00:00+00")}', '2026-11-20')).toBe(false);
    expect(approvalCoveredPayday('{["2026-11-20 08:00:00+00","2026-11-20 21:00:00+00")}', '2026-11-20')).toBe(false);
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
