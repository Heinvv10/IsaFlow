/**
 * Review M1 of e9f437f366: an off-cycle run was disbursed (approved "over payday") when some approval_history interval
 * OVERLAPS its payday, the SAST day [00:00, next 00:00). A late correction is allowed only then (offCyclePayDateRefusal);
 * the cash forecast's "disbursed" is the same predicate (approvalCoveredPaydaySql). Approved 10 Nov for a 20 Nov payday,
 * reopened 12 Nov and approved again 21 Nov never was: refused.
 */
import { describe, expect, it } from 'vitest';
import { approvalCoveredPayday } from '@/modules/accounting/services/payroll/payrollPaydayCover';
import { offCyclePayDateRefusal } from '@/modules/accounting/services/payroll/payrollOffCycleGates';

const D = '2026-11-20'; // payday: 2026-11-19 22:00 UTC to 2026-11-20 22:00 UTC
const run = (history: string | null) => ({ run_kind: 'off_cycle', run_date: D, approval_history: history });

describe('approvalCoveredPayday: an approval interval overlaps payday', () => {
  it('the review\'s cases', () => {
    // Approved 10 Nov, reopened on payday at 14:00 SAST: covered.
    expect(approvalCoveredPayday('{["2026-11-10 08:00:00+00","2026-11-20 12:00:00+00")}', D)).toBe(true);
    // Approved on payday 10:00 and reopened 15:00 the same day: covered.
    expect(approvalCoveredPayday('{["2026-11-20 08:00:00+00","2026-11-20 13:00:00+00")}', D)).toBe(true);
    expect(approvalCoveredPayday('{["2026-11-20 08:00:00+00","2026-11-20 21:00:00+00")}', D)).toBe(true);
    // Approved 10 Nov, reopened 12 Nov (the gate case): not covered.
    expect(approvalCoveredPayday('{["2026-11-10 08:00:00+00","2026-11-12 08:00:00+00")}', D)).toBe(false);
    // Approved only on 21 Nov: not covered.
    expect(approvalCoveredPayday('{["2026-11-21 08:00:00+00","2026-11-25 08:00:00+00")}', D)).toBe(false);
  });
  it('payday\'s bounds: [00:00 SAST, the next day\'s 00:00), inclusivity respected', () => {
    // Ending exactly at payday's start (exclusive upper): does not reach payday.
    expect(approvalCoveredPayday('{["2026-11-10 08:00:00+00","2026-11-19 22:00:00+00")}', D)).toBe(false);
    // Ending exactly at payday's start, inclusive: touches it.
    expect(approvalCoveredPayday('{["2026-11-10 08:00:00+00","2026-11-19 22:00:00+00"]}', D)).toBe(true);
    // Starting exactly when payday ends: after it.
    expect(approvalCoveredPayday('{["2026-11-20 22:00:00+00","2026-11-25 08:00:00+00")}', D)).toBe(false);
    expect(approvalCoveredPayday('{["2026-11-20 21:59:59+00","2026-11-25 08:00:00+00")}', D)).toBe(true);
  });
  it('several intervals, unbounded and infinite bounds, pg text forms', () => {
    expect(approvalCoveredPayday('{["2026-11-01 08:00:00+00","2026-11-02 08:00:00+00"),["2026-11-18 08:00:00+00","2026-11-22 08:00:00+00")}', D)).toBe(true);
    expect(approvalCoveredPayday('{(,"2026-11-22 08:00:00+00")}', D)).toBe(true);
    // Review L1: infinity / -infinity are bounds, as in SQL, never unparseable.
    expect(approvalCoveredPayday('{[-infinity,"2026-11-22 08:00:00+00")}', D)).toBe(true);
    expect(approvalCoveredPayday('{["2026-11-18 08:00:00+00",infinity)}', D)).toBe(true);
    expect(approvalCoveredPayday('{["2026-11-21 08:00:00+00",infinity)}', D)).toBe(false);
    expect(approvalCoveredPayday('{["2026-11-19 10:00:00.123456+02","2026-11-21 10:00:00.5+02")}', D)).toBe(true);
    expect(approvalCoveredPayday(null, D)).toBe(false);
    expect(approvalCoveredPayday('{}', D)).toBe(false);
  });
});

describe('offCyclePayDateRefusal after payday', () => {
  it('approved 10 Nov, reopened 12 Nov, approved again 21 Nov for a 20 Nov payday: refused', () => {
    expect(offCyclePayDateRefusal(run('{["2026-11-10 08:00:00+00","2026-11-12 08:00:00+00")}'), '2026-11-21')).toMatch(/before today/);
  });
  it('approved 10 Nov, reopened on payday at 14:00: the correction next day is allowed', () => {
    expect(offCyclePayDateRefusal(run('{["2026-11-10 08:00:00+00","2026-11-20 12:00:00+00")}'), '2026-11-21')).toBeNull();
  });
});
