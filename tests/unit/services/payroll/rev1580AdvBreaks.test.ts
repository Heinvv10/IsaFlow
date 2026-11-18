import { describe, expect, it } from 'vitest';
import { calculatePayrollLine } from '@/modules/accounting/services/payroll/payrollCalculator';
import { etiHoursOf } from '@/modules/accounting/services/payroll/etiHours';
import { runHoursOf } from '@/modules/accounting/services/payroll/payrollRunHours';
import { buildEmployeeRecord } from '@/modules/accounting/services/payroll/easyFileExportService';
import { allowanceCertificateFields } from '@/modules/accounting/services/payroll/payrollAllowanceFiling';
import type { EmployeeComponent, PayrollEmployee } from '@/modules/accounting/services/payroll/payrollTypes';

const comp = (id: string, code: string, amount: number, more: Partial<EmployeeComponent> = {}, taxable = true): EmployeeComponent => ({
  component: { id, name: id, sarsSourceCode: code, componentType: 'earning', isTaxable: taxable, isUifApplicable: taxable, isSdlApplicable: taxable },
  amount, ...more,
});
const employee = (more: Partial<PayrollEmployee> = {}): PayrollEmployee => ({
  id: 'e1', companyId: 'c', employeeNumber: 'E1', firstName: 'A', lastName: 'B', employmentType: 'permanent',
  startDate: new Date(2020, 0, 1), dateOfBirth: new Date(2002, 0, 1), idNumber: '0201015800083', uifExcluded: false, medicalAidMainMember: false,
  medicalAidDependantsCount: 0, taxStatus: 'employee', payBasis: 'monthly', hoursPerWeek: 40, ...more,
} as PayrollEmployee);

describe('B1 ETI hours count overtime twice for an hourly employee', () => {
  const hourly = employee({ payBasis: 'hourly', hourlyRate: 60 });
  const basic = comp('basic', '3601', 6000, { quantity: 100, quantityUnit: 'hour' });
  const ot = comp('ot', '3607', 900, { quantity: 10, quantityUnit: 'hour', rateMultiplier: 1.5 });
  it('100 ordinary + 10 overtime = 110 ETI hours, ordinary hours 100', () => {
    const run = runHoursOf(hourly, [basic, ot]);
    const h = etiHoursOf(hourly, { year: 2026, month: 11 } as never, run, [basic, ot]);
    expect([h.hours, h.ordinaryHours]).toEqual([110, 100]);
    expect(h.ordinaryHours).toBe(100);
  });
});

const baseEmp = {
  certificateNumber: '712345678920270200000000000001', yearOfAssessment: 2027, surname: 'B', firstNames: 'A', initials: 'A',
  idNumber: '0201015800085', taxNumber: '0123456789', employmentStartDate: '20260301', employmentEndDate: null, periodsInYoA: 12,
  annualPayments3605: 0, paye4102: 0, uifEmployee: 900, uifEmployer: 900, sdl4142: 900, taxThreshold: 99000,
};

describe('B2 a low earner with a within-rate km reimbursement: nil-tax reason counts non-taxable 3703 as income', () => {
  it('R90 000 salary (under the R99 000 threshold, PAYE nil) + R18 000 of 3703: reason 02 certificate, not a refusal', () => {
    const allowance = allowanceCertificateFields({ cash3701: 0, taxableCash3701: 0, vehicle3802: 0, payeIncluded: 0, legacyLines: 0,
      travel3702: 0, travel3703: 18000, travel3722: 0 });
    const rec = () => buildEmployeeRecord({ ...baseEmp, grossSalary3601: 90000, cashAllowances: allowance.cashAllowances } as never);
    expect(rec).not.toThrow();
  });
});

describe('B3 3722 certified without 3702 (rounding): whole export refused', () => {
  it('a year with R0.50 within and R5.50 above: certificate builds', () => {
    const allowance = allowanceCertificateFields({ cash3701: 0, taxableCash3701: 0, vehicle3802: 0, payeIncluded: 0, legacyLines: 0,
      travel3702: 0.5, travel3703: 0, travel3722: 5.5 });
    const rec = () => buildEmployeeRecord({ ...baseEmp, paye4102: 1000, taxThreshold: 99000, grossSalary3601: 200000, cashAllowances: allowance.cashAllowances } as never);
    expect(rec).not.toThrow();
  });
});

describe('B4 BCEA warning on an above-threshold employee is missed when travel... (control) / bonus month false positive', () => {
  it('R15 000 a month with a R15 000 annual bonus (3605) in December: R195 000 a year, below R269 600.90, no warning', () => {
    const line = calculatePayrollLine({ employee: employee(), period: { year: 2026, month: 12 }, taxYear: 2027, annualPayrollEstimate: 10_000_000,
      components: [comp('basic', '3601', 15000, { isRecurring: true }), comp('bonus', '3605', 15000), comp('ot', '3607', 1298.1, { quantity: 10, quantityUnit: 'hour', rateMultiplier: 1.5 })] });
    expect(line.validationResults.map((w) => w.code)).not.toContain('OVERTIME_ABOVE_BCEA_THRESHOLD');
  });
});

describe('B1b the double count fails the minimum-wage test: ETI lost on a paid line', () => {
  it('hourly R32 (NMW R30.23), 160 h + 20 h overtime at 1.5x: ETI is claimed as without overtime', () => {
    const young = employee({ payBasis: 'hourly', hourlyRate: 32, startDate: new Date(2026, 5, 1), dateOfBirth: new Date(2002, 0, 1) });
    const base = { employee: young, period: { year: 2026, month: 11 }, taxYear: 2027, annualPayrollEstimate: 10_000_000 };
    const basic = comp('basic', '3601', 5120, { quantity: 160, quantityUnit: 'hour' });
    const without = calculatePayrollLine({ ...base, components: [basic] });
    const withOt = calculatePayrollLine({ ...base, components: [basic, comp('ot', '3607', 960, { quantity: 20, quantityUnit: 'hour', rateMultiplier: 1.5 })] });
    expect(without.eti.monthlyEti).toBeGreaterThan(0);
    expect(withOt.eti.monthlyEti).toBeGreaterThan(0);
  });
});
