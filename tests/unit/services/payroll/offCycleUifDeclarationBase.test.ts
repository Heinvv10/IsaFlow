/**
 * Wave 6 OC (review of fd9193cc2): the UI-19 line view reads an off-cycle line's UIF base from its recorded monthly
 * calculation, not rebuilt in isolation. Regular pay at the ceiling leaves a R5 000 bonus no room: nil leviable, capped.
 */
import { describe, expect, it } from 'vitest';
import { recordedOffCycleUifBase, uifLineBase } from '@/modules/accounting/services/payroll/uifLeviableBase';
import { bonusLine, earlierFrom, regularLine } from './offCycleMonthLine.helpers';

describe('recordedOffCycleUifBase', () => {
  it('a bonus after regular pay at the ceiling: nil leviable and capped, as its calculation recorded', () => {
    const regular = regularLine(20_000);
    const bonus = bonusLine(5_000, earlierFrom(regular, 20_000));
    expect(bonus.uif.employeeContribution).toBe(0);
    expect(recordedOffCycleUifBase(bonus.explanations.uif.steps)).toEqual({ leviableSalary: 0, isCapped: true, exact: true });
    // Rebuilt in isolation it would read R5 000, uncapped.
    expect(uifLineBase(5_000, 0, 5_000)).toMatchObject({ leviableSalary: 5_000, isCapped: false });
  });

  it('a bonus with room under the ceiling: the room it levied on', () => {
    const bonus = bonusLine(5_000, earlierFrom(regularLine(15_000), 15_000));
    expect(recordedOffCycleUifBase(bonus.explanations.uif.steps)).toEqual({ leviableSalary: 2_712, isCapped: true, exact: true });
  });

  it('a regular line records no monthly calculation: null, so the rebuild decides', () => {
    expect(recordedOffCycleUifBase(regularLine(15_000).explanations.uif.steps)).toBeNull();
    expect(recordedOffCycleUifBase(null)).toBeNull();
  });
});
