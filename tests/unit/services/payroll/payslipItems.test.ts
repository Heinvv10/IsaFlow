/**
 * Wave 4 PS: a payslip's lines come from the stored run line, never recalculated.
 * Gross, PAYE, UIF and net are the stored figures; items explain them; a gap is a
 * labelled "Not itemised" line, never a silent re-total.
 */
import { describe, expect, it } from 'vitest';
import {
  itemisePayslip, NOT_ITEMISED, notItemisedNote, type StoredPayslipLine,
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

  it('an item whose type is not known (component gone from the catalogue) is never guessed: it is "Not itemised"', () => {
    const slip = itemisePayslip(LINE, new Map([['c-salary', 'earning']])); // overtime, medical and pension are unknown
    expect(slip.earnings).toEqual([
      { label: 'Basic Salary', code: '3601', amount: 30000 },
      { label: NOT_ITEMISED, code: '', amount: 1234.5 },
    ]);
    expect(slip.deductions).toEqual([{ label: NOT_ITEMISED, code: '', amount: 3800 }]);
    expect(slip.notItemised).toBe(true);
  });

  it('a breakdown stored as a JSON string is itemised by the same catalogue types', () => {
    const slip = itemisePayslip({ ...LINE, breakdown: JSON.stringify(LINE.breakdown) }, TYPES);
    expect(slip.earnings.map((e) => e.code)).toEqual(['3601', '3607']);
    expect(slip.deductions.map((d) => d.code)).toEqual(['4005', '4001']);
    expect(slip.notItemised).toBe(false);
  });

  it('an employer contribution in the breakdown is neither an earning nor a deduction: it is listed as the employer\'s', () => {
    const types = new Map([...TYPES, ['c-erpf', 'employer_contribution']]);
    const erpf = item('c-erpf', 'Employer Pension', '4472', 1500);
    const slip = itemisePayslip({ ...LINE, breakdown: [...(LINE.breakdown as object[]), erpf] }, types);
    expect(slip.earnings.map((e) => e.label)).toEqual(['Basic Salary', 'Overtime']);
    expect(slip.deductions.map((d) => d.label)).toEqual(['Medical Aid', 'Pension Fund']);
    expect(slip.employerContributions).toEqual([{ label: 'Employer Pension', code: '4472', amount: 1500 }]);
    expect(slip.notItemised).toBe(false);
  });

  it('an unreadable breakdown itemises nothing: every amount is "Not itemised"', () => {
    const slip = itemisePayslip({ ...LINE, breakdown: '{not json' }, TYPES);
    expect(slip.earnings).toEqual([{ label: NOT_ITEMISED, code: '', amount: 31234.5 }]);
    expect(slip.deductions).toEqual([{ label: NOT_ITEMISED, code: '', amount: 3800 }]);
  });
});

describe('notItemisedNote: worded by cause', () => {
  it('none when everything is itemised', () => {
    expect(notItemisedNote(itemisePayslip(LINE, TYPES))).toBeNull();
  });

  it('a positive gap: part of a stored total is not broken down into items', () => {
    const note = notItemisedNote(itemisePayslip(LINE, new Map([['c-salary', 'earning']])));
    expect(note).toMatch(/not broken down into items/);
    expect(note).not.toMatch(/more than the stored total/);
  });

  it('a negative gap (net floored at nil): the items add up to more than the stored total, not "calculated before items"', () => {
    const types = new Map([['sal', 'earning'], ['g', 'deduction']]);
    const slip = itemisePayslip({
      grossPay: 5000, paye: 0, uifEmployee: 50, uifEmployer: 50, sdl: 0, netPay: 0,
      breakdown: [item('sal', 'Salary', '3601', 5000), item('g', 'Garnishee', '4102', 6000)],
    }, types);
    expect(slip.deductions.at(-1)).toEqual({ label: NOT_ITEMISED, code: '', amount: -1050 });
    const note = notItemisedNote(slip);
    expect(note).toMatch(/more than the stored total/);
    expect(note).not.toMatch(/calculated before items were recorded|not broken down/);
  });
});
