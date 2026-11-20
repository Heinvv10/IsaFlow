/**
 * Wave 6 PSP, review of #1566: what a PSP's line may carry (M3/M4), the flat rate's base (before any deduction, less
 * non-cash items), the cent rounding (L2), the payslip basis (L1) and the per-line flag (H1/H2).
 */
import { describe, expect, it } from 'vitest';
import {
  pspComponentResults, pspDirectiveResults, pspPayeBase, pspRefusedKind, pspTaxBasis,
} from '@/modules/accounting/services/payroll/pspLineRules';
import { pspFlatPaye, outsideTablesResult } from '@/modules/accounting/services/payroll/taxStatusTreatment';
import { isPspLine, isContractorLine } from '@/modules/accounting/services/payroll/payrollOutsideTables';
import { particulars } from '@/modules/accounting/services/payroll/payslipFacts';
import type { EmployeeComponent } from '@/modules/accounting/services/payroll/payrollTypes';
import type { Payslip, PayslipRun } from '@/modules/accounting/services/payroll/payslipModel';

const comp = (code: string, type: 'earning' | 'deduction', amount: number, more: Partial<EmployeeComponent> = {}): EmployeeComponent => ({
  component: { id: `c-${code}`, name: `C${code}`, sarsSourceCode: code, componentType: type, isTaxable: true, isUifApplicable: false, isSdlApplicable: true },
  amount, ...more,
});

describe('pspRefusedKind', () => {
  it.each([
    ['4001', 'deduction', 'retirement fund contribution'], ['4003', 'deduction', 'retirement fund contribution'],
    ['4006', 'deduction', 'retirement fund contribution'], ['3817', 'earning', 'retirement fund contribution'],
    ['3828', 'earning', 'retirement fund contribution'], ['4030', 'deduction', 's18A donation'],
    ['LOAN', 'deduction', 'loan'], ['3801', 'earning', 'loan'], ['3802', 'earning', 'fringe benefit'],
    ['3810', 'earning', 'fringe benefit'], [' 4001 ', 'deduction', 'retirement fund contribution'],
    ['3701', 'earning', 'travel allowance'], ['IRP3(c)', 'directive', 'IRP3(c) directive'],
  ])('%s (%s) is refused as a %s', (code, type, kind) => {
    expect(pspRefusedKind({ sarsSourceCode: code, componentType: type })).toBe(kind);
  });

  it.each([['3601', 'earning'], ['3605', 'earning'], ['3702', 'earning'], ['4005', 'deduction'], ['4474', 'deduction']])('%s (%s) is allowed', (code, type) => {
    expect(pspRefusedKind({ sarsSourceCode: code, componentType: type })).toBeNull();
  });

  it('a non-cash earning under any code is a fringe benefit', () => {
    expect(pspRefusedKind({ sarsSourceCode: '3601', componentType: 'earning' }, true)).toBe('fringe benefit');
  });
});

describe('pspComponentResults: an error on the line, naming each refused item', () => {
  it('names the retirement contribution and the fringe benefit; nil amounts and allowed items are not named', () => {
    const [r] = pspComponentResults([comp('3601', 'earning', 40_000), comp('4001', 'deduction', 1_000),
      comp('3802', 'earning', 2_000, { isNonCash: true }), comp('4030', 'deduction', 0)]);
    expect(r!.code).toBe('PSP_COMPONENT_REFUSED');
    expect(r!.severity).toBe('error');
    expect(r!.message).toContain('C4001 (retirement fund contribution)');
    expect(r!.message).toContain('C3802 (fringe benefit)');
    expect(r!.message).not.toContain('C4030');
  });
  it('none for a plain fee', () => {
    expect(pspComponentResults([comp('3601', 'earning', 40_000)])).toEqual([]);
  });
});

describe('pspDirectiveResults (L3)', () => {
  it('an IRP3(c) fixed amount is an error naming the directive; an IRP3(b) or none is no result', () => {
    const [r] = pspDirectiveResults({ type: 'fixed_amount', number: 'D-9' });
    expect([r!.code, r!.severity]).toEqual(['PSP_DIRECTIVE_REFUSED', 'error']);
    expect(r!.message).toContain('IRP3(c)');
    expect(r!.message).toContain('D-9');
    expect(pspDirectiveResults({ type: 'fixed_percentage', number: null })).toEqual([]);
    expect(pspDirectiveResults(null)).toEqual([]);
  });
});

describe('pspPayeBase: before any deduction, less non-cash earnings', () => {
  it('deductions do not reach it; a non-cash benefit (at its inclusion rate) comes out; never below nil', () => {
    const rem = { periodic: 50_000, annualPayment: 5_000 };
    expect(pspPayeBase(rem, [comp('3601', 'earning', 50_000), comp('4001', 'deduction', 10_000)])).toBe(55_000);
    expect(pspPayeBase(rem, [comp('3802', 'earning', 10_000, { isNonCash: true, payeInclusionRate: 0.8 })])).toBe(47_000);
    expect(pspPayeBase({ periodic: 0, annualPayment: 0 }, [comp('3802', 'earning', 10_000, { isNonCash: true })])).toBe(0);
    // A cash earning an employee includes in part (80% of a 3701) is a payment to a PSP in full.
    expect(pspPayeBase({ periodic: 48_000, annualPayment: 0 }, [comp('3601', 'earning', 40_000), comp('3701', 'earning', 10_000, { payeInclusionRate: 0.8 })])).toBe(50_000);
  });
});

describe('pspFlatPaye: integer cents, half-up (L2)', () => {
  it.each([[0.45, 10_001.9, 4_500.86], [0.27, 100.01, 27], [0.27, 0.01, 0], [0.45, 0.01, 0], [0.27, 40_000, 10_800], [0.45, -5, 0], [0.27, 1.85, 0.5]])(
    '%s x %s = %s', (rate, base, paye) => {
      expect(pspFlatPaye(rate, base)).toBe(paye);
    });
});

describe('the per-line flag and the payslip basis', () => {
  const company = outsideTablesResult('flat_psp', { entity: 'company', rate: 0.27 });
  it('a PSP line is a PSP line, not a contractor line', () => {
    expect(isPspLine(company)).toBe(true);
    expect(isContractorLine(company)).toBe(false);
    expect(isPspLine(outsideTablesResult('none'))).toBe(false);
  });
  it('states the entity, the rate and no UIF; nothing for any other line', () => {
    expect(pspTaxBasis(company)).toBe('Personal service provider (company): PAYE at 27%, no UIF');
    expect(pspTaxBasis(outsideTablesResult('flat_psp', { entity: 'trust', rate: 0.45 }))).toBe('Personal service provider (trust): PAYE at 45%, no UIF');
    expect(pspTaxBasis(outsideTablesResult('flat_25'))).toBeNull();
    expect(pspTaxBasis(null)).toBeNull();
  });
  it('the payslip particulars print it after "Paid by"; an employee\'s slip has no such row', () => {
    const slip = { employeeName: 'A B', employeeNumber: 'E1', occupation: null, taxNumber: null, paymentMethod: 'cash',
      workedOrdinary: null, workedOvertime: null, hoursPerWeek: null, hoursPerDay: null, payBasis: 'monthly', hourlyRate: null, dailyRate: null,
      taxBasis: pspTaxBasis(company) } as unknown as Payslip;
    const run = { final: true, detailsAsAt: 'approval', runDate: null } as unknown as PayslipRun;
    const facts = particulars(run, slip, 'March 2026');
    const at = facts.findIndex(([k]) => k === 'Tax basis');
    expect(facts[at - 1]![0]).toBe('Paid by');
    expect(facts[at]![1]).toBe('Personal service provider (company): PAYE at 27%, no UIF');
    expect(particulars(run, { ...slip, taxBasis: null }, 'March 2026').some(([k]) => k === 'Tax basis')).toBe(false);
  });
});
