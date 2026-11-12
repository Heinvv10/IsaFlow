/**
 * The UI-19 line view rebuilds the UIF base the way the calculator built it: a taxable 3701 / 3802 counts at its PAYE share
 * (UIF Contributions Act s1, remuneration as the Fourth Schedule para 1 defines it), stored as `payeIncludedAmount`.
 */
import { describe, expect, it } from 'vitest';
import { rebuildUifLeviable, uifLineBase } from '@/modules/accounting/services/payroll/uifLeviableBase';

const salaryId = '11111111-1111-4111-8111-111111111111';
const travelId = '22222222-2222-4222-8222-222222222222';
const types = new Map([[salaryId, 'earning'], [travelId, 'earning']]);

describe('rebuildUifLeviable with a 3701 at its PAYE share', () => {
  const items = [
    { componentId: salaryId, amount: 10000, isUifApplicable: true },
    { componentId: travelId, amount: 5000, isUifApplicable: true, payeIncludedAmount: 4000 },
  ];
  it('R10 000 + a 3701 of 5 000 is UIF on 14 000: R140.00, rebuilt exactly', () => {
    const leviable = rebuildUifLeviable(items, types);
    expect(leviable).toBe(14000);
    expect(uifLineBase(15000, 140, leviable)).toEqual({ leviableSalary: 14000, isCapped: false, exact: true });
  });
  it('a line stored before the share (no payeIncludedAmount) is rebuilt on the whole amount, as it was calculated', () => {
    const legacy = [items[0]!, { componentId: travelId, amount: 5000, isUifApplicable: true }];
    expect(rebuildUifLeviable(legacy, types)).toBe(15000);
    expect(uifLineBase(15000, 150, 15000).exact).toBe(true);
  });
});
