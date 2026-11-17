/**
 * RI (wave 6): overtime priced at hours x hourly rate x multiplier (BCEA 75 of 1997 s10(2) 1.5x, s16(1) 2x), and a km row split at
 * the prescribed rate a km (SARS allowances guide, Travel Allowance from 1 March 2018: within the rate not taxed, 3703 or 3702; the
 * excess "irrespective of the kilometers travelled" taxed, 3722). R4.95 a km in tax year 2027 (PAYE-GEN-01-G03-A01 Rev 19 p. 2).
 */
import { describe, expect, it } from 'vitest';
import { calculatePayrollLine } from '@/modules/accounting/services/payroll/payrollCalculator';
import {
  bceaThresholdAt, overtimeAmountCents, overtimeHourlyRate, overtimeThresholdWarnings, splitTravelRows,
} from '@/modules/accounting/services/payroll/payrollRunInputUnits';
import { hoursValidation, runHoursOf } from '@/modules/accounting/services/payroll/payrollRunHours';
import type { EmployeeComponent, PayrollEmployee } from '@/modules/accounting/services/payroll/payrollTypes';

const comp = (id: string, code: string, amount: number, more: Partial<EmployeeComponent> = {}, taxable = true): EmployeeComponent => ({
  component: { id, name: id, sarsSourceCode: code, componentType: 'earning', isTaxable: taxable, isUifApplicable: taxable, isSdlApplicable: taxable },
  amount, ...more,
});
const salary = comp('basic', '3601', 20000, { isRecurring: true });
const km = (amount: number, kms: number) => comp('travel', '3703', amount, { quantity: kms, quantityUnit: 'km' }, false);
const employee = (more: Partial<PayrollEmployee> = {}): PayrollEmployee => ({
  id: 'e1', companyId: 'c', employeeNumber: 'E1', firstName: 'A', lastName: 'B', employmentType: 'permanent',
  startDate: new Date(2020, 0, 1), dateOfBirth: new Date(1986, 0, 1), uifExcluded: false, medicalAidMainMember: false,
  medicalAidDependantsCount: 0, taxStatus: 'employee', payBasis: 'monthly', hoursPerWeek: 40, ...more,
} as PayrollEmployee);

describe('overtime pricing', () => {
  it('10 h at R60 x 1.5 is R900.00 and 8 h x 2 is R960.00 (the oracle cases); 0.1 h x R0.10 x 1.5 rounds to a cent', () => {
    expect(overtimeAmountCents(10, 60, 1.5)).toBe(90000);
    expect(overtimeAmountCents(8, 60, 2)).toBe(96000);
    expect(overtimeAmountCents(0.1, 0.1, 1.5)).toBe(2);
  });

  it('hourly rate: the hourly rate; a day rate over the hours a day; monthly basic over hours a week x 52 / 12; else null', () => {
    expect(overtimeHourlyRate(employee({ payBasis: 'hourly', hourlyRate: 85.5 }), 0)).toBe(85.5);
    expect(overtimeHourlyRate(employee({ payBasis: 'daily', dailyRate: 640, hoursPerDay: 8 }), 0)).toBe(80);
    expect(overtimeHourlyRate(employee(), 20000)).toBe(115.38);
    expect(overtimeHourlyRate(employee({ hoursPerWeek: null }), 20000)).toBeNull();
    expect(overtimeHourlyRate(employee({ payBasis: 'daily', dailyRate: 640, hoursPerDay: null }), 0)).toBeNull();
  });
});

describe('travel km split at the prescribed rate', () => {
  it('within the rate, nothing else paid: one non-taxable 3703 row', () => {
    const { components, warnings } = splitTravelRows([salary, km(4000, 1000)], 2027);
    expect(components.slice(1).map((c) => [c.component.sarsSourceCode, c.amount, c.component.isTaxable])).toEqual([['3703', 4000, false]]);
    expect(warnings).toEqual([]);
  });

  it('above the rate: 3702 at km x R4.95 and the excess as taxable 3722', () => {
    const { components } = splitTravelRows([salary, km(6000, 1000)], 2027);
    expect(components.slice(1).map((c) => [c.component.sarsSourceCode, c.amount, c.component.isTaxable, c.component.isUifApplicable])).toEqual([
      ['3702', 4950, false, false], ['3722', 1050, true, true],
    ]);
  });

  it('within the rate but a 3701 travel allowance is also paid: 3702, still not taxed', () => {
    const { components } = splitTravelRows([salary, comp('allowance', '3701', 3000), km(4000, 1000)], 2027);
    expect(components.slice(2).map((c) => [c.component.sarsSourceCode, c.amount, c.component.isTaxable])).toEqual([['3702', 4000, false]]);
  });

  it('tax year 2026 splits at R4.76; 2025 (rate unverified) taxes it all and warns', () => {
    expect(splitTravelRows([km(6000, 1000)], 2026).components.map((c) => c.amount)).toEqual([4760, 1240]);
    const y2025 = splitTravelRows([km(6000, 1000)], 2025);
    expect(y2025.components.map((c) => [c.component.sarsSourceCode, c.amount])).toEqual([['3722', 6000]]);
    expect(y2025.warnings.map((w) => w.code)).toEqual(['TRAVEL_RATE_NOT_LOADED']);
  });

  it('on the line: gross pays all of it, PAYE, UIF and SDL see only the excess', () => {
    const base = { employee: employee(), period: { year: 2026, month: 11 }, taxYear: 2027, annualPayrollEstimate: 10_000_000 };
    const plain = calculatePayrollLine({ ...base, components: [salary, comp('excess', '3601', 1050)] });
    const line = calculatePayrollLine({ ...base, components: [salary, km(6000, 1000)] });
    expect(line.grossPay).toBe(26000);
    expect(line.taxableIncome).toBe(21050);
    expect([line.paye.monthlyPaye, line.uif.employeeContribution, line.sdl]).toEqual([plain.paye.monthlyPaye, plain.uif.employeeContribution, plain.sdl]);
  });
});

describe('the hours machinery leaves overtime and km rows alone; ETI hours include overtime', () => {
  const hourly = employee({ payBasis: 'hourly', hourlyRate: 60 });
  const hours = comp('basic', '3601', 9600, { quantity: 160, quantityUnit: 'hour' });
  const overtime = comp('ot', '3607', 900, { quantity: 10, quantityUnit: 'hour', rateMultiplier: 1.5 });
  it('an hourly employee with overtime is not HOURS_DUPLICATE, and works 170 hours', () => {
    expect(hoursValidation(hourly, [hours, overtime]).map((v) => v.code)).toEqual([]);
    expect(runHoursOf(hourly, [hours, overtime])).toBe(170);
  });
  it('a km row on a monthly employee is not HOURS_UNIT_MISMATCH', () => {
    expect(hoursValidation(employee(), [salary, km(100, 10)])).toEqual([]);
  });
});

describe('OVERTIME_ABOVE_BCEA_THRESHOLD (BCEA s6(3)): a warning, never a refusal', () => {
  const ot = comp('ot', '3607', 2000, { quantity: 10, quantityUnit: 'hour', rateMultiplier: 1.5 });
  it('the threshold by date: none before 1 April 2025, R261 748.45, then R269 600.90 from 1 May 2026', () => {
    expect(bceaThresholdAt('2025-03-31')).toBeNull();
    expect(bceaThresholdAt('2025-04-01')).toBe(261_748.45);
    expect(bceaThresholdAt('2026-04-30')).toBe(261_748.45);
    expect(bceaThresholdAt('2026-05-01')).toBe(269_600.9);
  });
  it('warns at R22 500 a month (R270 000 a year) on a multiplier, not at R22 400, not without overtime', () => {
    const at = (pay: number, rows: EmployeeComponent[]) => overtimeThresholdWarnings([comp('b', '3601', pay), ...rows], '2026-11-28').map((w) => w.code);
    expect(at(22500, [ot])).toEqual(['OVERTIME_ABOVE_BCEA_THRESHOLD']);
    expect(at(22400, [ot])).toEqual([]);
    expect(at(22500, [])).toEqual([]);
  });
  it('a travel reimbursement is not earnings: R22 400 with R6 000 of km (R1 050 above the rate) does not warn', () => {
    const line = calculatePayrollLine({ employee: employee(), components: [comp('b', '3601', 22400), ot, km(6000, 1000)], period: { year: 2026, month: 11 }, taxYear: 2027, annualPayrollEstimate: 10_000_000 });
    expect(line.validationResults.map((v) => v.code)).not.toContain('OVERTIME_ABOVE_BCEA_THRESHOLD');
  });

  it('reaches the line as a warning', () => {
    const line = calculatePayrollLine({ employee: employee(), components: [comp('b', '3601', 30000), ot], period: { year: 2026, month: 11 }, taxYear: 2027, annualPayrollEstimate: 10_000_000 });
    expect(line.validationResults.find((v) => v.code === 'OVERTIME_ABOVE_BCEA_THRESHOLD')?.severity).toBe('warning');
  });
});
