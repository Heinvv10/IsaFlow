/**
 * Wave 4 PS: a payslip's lines come from the stored run line, never recalculated.
 * Gross, PAYE, UIF and net are the stored figures; items explain them; a gap is a
 * labelled "Not itemised" line, never a silent re-total.
 */
import { describe, expect, it } from 'vitest';
import {
  itemisePayslip, NOT_ITEMISED, type StoredPayslipLine,
} from '@/modules/accounting/services/payroll/payslipItems';

const TYPES = new Map([
  ['c-salary', 'earning'], ['c-ot', 'earning'], ['c-loanbenefit', 'earning'],
  ['c-medical', 'deduction'], ['c-pension', 'deduction'], ['c-ra', 'deduction'],
]);

const item = (componentId: string, componentName: string, sarsSourceCode: string, amount: number, extra: object = {}) =>
  ({ componentId, componentName, sarsSourceCode, amount, isTaxable: true, isUifApplicable: true, ...extra });

// R30 000 salary + R1 234.50 overtime; R1 800 medical + R2 000 pension; stored PAYE/UIF/net as the calculator wrote them.
const LINE: StoredPayslipLine = {
  grossPay: 31234.5, paye: 6012.34, uifEmployee: 177.12, uifEmployer: 177.12, sdl: 312.35,
  netPay: 21245.04,
  breakdown: [
    item('c-salary', 'Basic Salary', '3601', 30000),
    item('c-ot', 'Overtime', '3607', 1234.5),
    item('c-medical', 'Medical Aid', '4005', 1800),
    item('c-pension', 'Pension Fund', '4001', 2000),
  ],
};

describe('itemisePayslip', () => {
  it('earnings, deductions, PAYE, UIF and net are the stored figures, and the items add up to them', () => {
    const slip = itemisePayslip(LINE, TYPES);
    expect(slip.earnings).toEqual([
      { label: 'Basic Salary', code: '3601', amount: 30000 },
      { label: 'Overtime', code: '3607', amount: 1234.5 },
    ]);
    expect(slip.deductions).toEqual([
      { label: 'Medical Aid', code: '4005', amount: 1800 },
      { label: 'Pension Fund', code: '4001', amount: 2000 },
    ]);
    expect(slip).toMatchObject({
      grossPay: 31234.5, paye: 6012.34, uifEmployee: 177.12, netPay: 21245.04, uifEmployer: 177.12, sdl: 312.35,
      otherDeductions: 3800, notItemised: false,
    });
  });

  it('carries a gap between the items and the stored gross as a labelled "Not itemised" earning', () => {
    // A line from before the breakdown flags: R31 234.50 stored gross, only the salary itemised.
    const slip = itemisePayslip({ ...LINE, breakdown: (LINE.breakdown as object[]).filter((_, i) => i !== 1) }, TYPES);
    expect(slip.earnings.at(-1)).toEqual({ label: NOT_ITEMISED, code: '', amount: 1234.5 });
    expect(slip.grossPay).toBe(31234.5);
    expect(slip.notItemised).toBe(true);
  });

  it('net is read, never computed: a stored net that differs from gross less the items shows as a deduction not itemised', () => {
    // Stored net R100.00 below what gross − PAYE − UIF − items gives: the slip prints the stored net and itemises the gap.
    const slip = itemisePayslip({ ...LINE, netPay: 21145.04 }, TYPES);
    expect(slip.netPay).toBe(21145.04);
    expect(slip.otherDeductions).toBe(3900);
    expect(slip.deductions.at(-1)).toEqual({ label: NOT_ITEMISED, code: '', amount: 100 });
    expect(slip.notItemised).toBe(true);
  });

  it('a non-cash benefit is not in gross: it is listed as a benefit, not paid', () => {
    const benefit = item('c-loanbenefit', 'Low-interest loan benefit', '3801', 250, { isNonCash: true });
    const slip = itemisePayslip({ ...LINE, breakdown: [...(LINE.breakdown as object[]), benefit] }, TYPES);
    expect(slip.benefits).toEqual([{ label: 'Low-interest loan benefit', code: '3801', amount: 250 }]);
    expect(slip.earnings.map((e) => e.code)).toEqual(['3601', '3607']);
    expect(slip.notItemised).toBe(false);
  });

  it('a contribution paid outside payroll is not a deduction from pay: it is listed as paid directly', () => {
    const ra = item('c-ra', 'Retirement annuity', '4006', 1500, { paidOutsidePayroll: true, retirementContribution: true });
    const slip = itemisePayslip({ ...LINE, breakdown: [...(LINE.breakdown as object[]), ra] }, TYPES);
    expect(slip.paidDirectly).toEqual([{ label: 'Retirement annuity', code: '4006', amount: 1500 }]);
    expect(slip.deductions.map((d) => d.code)).toEqual(['4005', '4001']);
    expect(slip.notItemised).toBe(false);
  });

  it('an item whose component is gone from the catalogue is classed by its SARS code', () => {
    const slip = itemisePayslip(LINE, new Map());
    expect(slip.deductions.map((d) => d.code)).toEqual(['4005', '4001']);
    expect(slip.earnings.map((d) => d.code)).toEqual(['3601', '3607']);
  });

  it('an unreadable breakdown itemises nothing: every amount is "Not itemised"', () => {
    const slip = itemisePayslip({ ...LINE, breakdown: '{not json' }, TYPES);
    expect(slip.earnings).toEqual([{ label: NOT_ITEMISED, code: '', amount: 31234.5 }]);
    expect(slip.deductions).toEqual([{ label: NOT_ITEMISED, code: '', amount: 3800 }]);
  });
});
