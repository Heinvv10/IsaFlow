/**
 * Which components the pay-run grid may set (decision 7). The rule is what stands between
 * a keystroke and a tax figure, so it is pinned code by code; the DB path is in
 * tests/integration/payrun-period-inputs.int.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn(), withTransaction: vi.fn() }));

import { EDITABLE_LOCAL_DEDUCTION_CODES, isEditableRunComponent } from '@/modules/accounting/services/payroll/payrollRunPeriodInputs';

const earning = (sarsSourceCode: string, isTaxable = true) => ({ sarsSourceCode, componentType: 'earning', isTaxable });
const deduction = (sarsSourceCode: string, isTaxable = false) => ({ sarsSourceCode, componentType: 'deduction', isTaxable });

describe('isEditableRunComponent', () => {
  it.each(['3601', '3606', '3607', ' 3607\n'])('earning %j: regular pay', (code) => {
    expect(isEditableRunComponent(earning(code))).toBe(true);
  });

  it.each(['3605', '3901', '3907', '3801', '3701', '3713', 'BONUS'])('earning %s: refused', (code) => {
    expect(isEditableRunComponent(earning(code))).toBe(false);
  });

  it('an earning not flagged taxable is refused', () => {
    expect(isEditableRunComponent(earning('3601', false))).toBe(false);
  });

  it.each(['4001', '4002', '4003', '4004', '4005', '4006', '4007', '4018', '4024', '4026', '4030', '4102', '4141', '4142', '4150', '4472', '4473', '4474', '4475', '4476', '4497', '3605', '3907'])(
    'deduction %s: a SARS code, refused', (code) => {
      expect(isEditableRunComponent(deduction(code))).toBe(false);
    });

  it('a deduction with whitespace round a SARS code is still that code', () => {
    expect(isEditableRunComponent(deduction(' 4005\t'))).toBe(false);
  });

  it.each(['LOAN', 'loan', ' LOAN '])('deduction %j: the loan service\'s', (code) => {
    expect(isEditableRunComponent(deduction(code))).toBe(false);
  });

  it('a listed company-local deduction with no tax effect is editable', () => {
    expect(isEditableRunComponent(deduction('UNION'))).toBe(true);
    expect(isEditableRunComponent(deduction(' union '))).toBe(true);
  });

  it.each(['SACCO', 'GARNISHEE', 'OTHER', 'A123'])('a local deduction not on the list is refused: %s', (code) => {
    expect(isEditableRunComponent(deduction(code))).toBe(false);
  });

  it('the list holds no four-digit SARS code and not LOAN', () => {
    expect([...EDITABLE_LOCAL_DEDUCTION_CODES].filter((c) => /^\d{4}$/.test(c) || c === 'LOAN')).toEqual([]);
  });

  it('a taxable deduction moves PAYE, so it is refused', () => {
    expect(isEditableRunComponent(deduction('UNION', true))).toBe(false);
  });

  it('an employer contribution is refused whatever its code', () => {
    expect(isEditableRunComponent({ sarsSourceCode: '3601', componentType: 'employer_contribution', isTaxable: true })).toBe(false);
    expect(isEditableRunComponent({ sarsSourceCode: 'UNION', componentType: 'employer_contribution', isTaxable: false })).toBe(false);
  });
});
