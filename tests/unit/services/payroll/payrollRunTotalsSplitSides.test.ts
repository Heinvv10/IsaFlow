/**
 * Wave 6 OC (review of fd9193cc2): the journal books each UIF side as the lines hold it. An off-cycle line's sides can
 * differ (R127.12 employee, R137.12 employer on the R15 000 bonus fixture); halving the total misstates both.
 */
import { describe, expect, it } from 'vitest';
import { splitRunTotals } from '@/modules/accounting/services/payroll/payrollRunTotalsSplit';

describe('splitRunTotals: UIF sides', () => {
  it('the employee side is the lines\' own; the employer side the rest of the total', () => {
    const s = splitRunTotals({ gross: 15_000, paye: 4_000, uif: 264.24, net: 10_872.88, uifEmployee: 127.12 });
    expect(s).toEqual({ employeeUif: 127.12, employerUif: 137.12, otherDeductions: 0 });
  });
  it('with no line figure, half each (the sides sum to the total)', () => {
    expect(splitRunTotals({ gross: 10_000, paye: 0, uif: 200.01, net: 9_900 })).toMatchObject({ employeeUif: 100.01, employerUif: 100 });
  });
});
