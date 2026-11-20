/**
 * Review #1679 (payroll L1): the run list's `final` flag (mapRunRow, payRunIsFinal) for the rows the off-cycle picker
 * reads: a stamped paid run and a grandfathered approved run are final; an approved run with no stamp is not; a row read
 * without the stamp columns carries no flag at all.
 */
import { describe, expect, it } from 'vitest';
import { mapRunRow } from '@/modules/accounting/services/payroll/payrollRunHeaders';

const row = (over: Record<string, unknown>) => ({
  id: 'r', company_id: 'c', period_month: 11, period_year: 2026, status: 'approved', pay_frequency: 'monthly', run_kind: 'regular',
  approved_at: null, approval_grandfathered_at: null, ...over,
});

describe('mapRunRow: final', () => {
  it('a stamped paid run is final', () => {
    expect(mapRunRow(row({ status: 'paid', approved_at: new Date('2026-11-20T08:00:00Z') })).final).toBe(true);
  });
  it('a grandfathered approved run is final', () => {
    expect(mapRunRow(row({ approval_grandfathered_at: '2026-01-01T00:00:00Z' })).final).toBe(true);
  });
  it('an approved run with no stamp is not final', () => {
    expect(mapRunRow(row({})).final).toBe(false);
  });
  it('a row read without the stamp columns carries no flag', () => {
    const { approved_at: _a, approval_grandfathered_at: _g, ...bare } = row({});
    expect('final' in mapRunRow(bare)).toBe(false);
  });
});
