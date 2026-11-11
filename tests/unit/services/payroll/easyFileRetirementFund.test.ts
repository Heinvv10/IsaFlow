/**
 * PAYE 4c: the employee's retirement fund contributions on the e@syFile record.
 *
 * SARS BRS PAYE Employer Reconciliation V25.3.0 (Jun-26):
 * - p. 101: 4001 "Total pension fund contributions paid and 'deemed paid' by
 *   employee"; 4003 "Total provident fund contributions paid and 'deemed paid'
 *   by employee"; p. 102: 4006 "Total retirement annuity fund contributions
 *   paid and 'deemed paid' by employee".
 * - p. 53-54 (Deductions/Contributions, N15): "All deductions and
 *   contributions that have a value must be reported, and those that do not
 *   have a value must not be reported"; "Cents must be omitted"; "No negative
 *   amounts are allowed".
 * - 4474 is the EMPLOYER's medical scheme contributions (p. 103), and 4472 /
 *   4473 / 4475 the employer's fund contributions beside 3817 / 3825 / 3828
 *   (p. 54): PAYE 4b, never emitted here.
 * The contributions are reported whole, not the capped deduction: SARS
 * PAYE-GEN-01-G21 (2027) p. 11 "Total current retirement annuity fund
 * contributions reflect under code 4006".
 */
import { describe, expect, it } from 'vitest';
import { buildEmployeeRecord, type EmployeeInput } from '@/modules/accounting/services/payroll/easyFileExportService';
import { withDeductionTotal } from '@/modules/accounting/services/payroll/easyFileRetirementFields';
import { validateCertificateTaxFields } from '@/modules/accounting/services/payroll/irp5ValidationEngine';

const base: EmployeeInput = {
  certificateNumber: '712345678920270200000000000001',
  yearOfAssessment: 2027,
  surname: 'Molefe',
  firstNames: 'Thandi',
  initials: 'T',
  idNumber: '9001015009087',
  taxNumber: '0123456789',
  employmentStartDate: '20250301',
  employmentEndDate: null,
  periodsInYoA: 12,
  grossSalary3601: 720_000,
  paye4102: 149_285.88,
  uifEmployee: 2_125.44,
  uifEmployer: 2_125.44,
  sdl4142: 7_200,
  taxThreshold: 99_000,
};
const at = (lines: string[], code: string) => lines.findIndex(l => l.startsWith(`${code},`));

describe('PAYE 4c: 4001 / 4003 / 4006 on the certificate', () => {
  it('each code with a value, cents dropped, in code order around 4005 and before 4102', () => {
    const lines = buildEmployeeRecord({
      ...base,
      retirementFund: { pension4001: 1_200.6, provident4003: 0.4, annuity4006: 32_503.08, donations4030: 0 },
      medical: { fees: 96_000, credit: 15_120, additionalCredit: 0, age65OrOlder: false, recorded: true },
    });
    expect(lines).toContain('4001,1200');
    expect(lines).toContain('4006,32503');
    // 0.40 has no value once the cents are dropped, and "those that do not have a value must not be reported".
    expect(at(lines, '4003')).toBe(-1);
    expect(at(lines, '4001')).toBeLessThan(at(lines, '4005'));
    expect(at(lines, '4005')).toBeLessThan(at(lines, '4006'));
    expect(at(lines, '4006')).toBeLessThan(at(lines, '4102'));
    expect(lines.some(l => /^44(72|73|74|75),/.test(l))).toBe(false);
    expect(validateCertificateTaxFields(lines)).toEqual([]);
  });

  it('no contributions: no retirement code at all', () => {
    const lines = buildEmployeeRecord({ ...base, retirementFund: { pension4001: 0, provident4003: 0, annuity4006: 0, donations4030: 0 } });
    expect(lines.some(l => /^400[1-7],/.test(l))).toBe(false);
    expect(buildEmployeeRecord(base).some(l => /^400[1-7],/.test(l))).toBe(false);
  });
});

/**
 * 4030 and 4497. BRS V25.3.0 p. 102: 4030 "Donations deducted from the employee's remuneration and paid by the employer
 * to an approved Organisation", reported in full (PAYE-GEN-01-G21 (2027) p. 11: "not only the allowable portion").
 * p. 57: 4497 "Total of all values specified under 40-deduction, 44-contribution and 45-information codes", mandatory
 * when any of them is completed, not completed when none is; cents omitted, no negatives.
 */
describe('4030 donations and the 4497 total on the certificate', () => {
  const fund = { pension4001: 0, provident4003: 0, annuity4006: 0, donations4030: 0 };

  it('reports the donations in full after 4006, and 4497 totals the emitted deduction codes before 4102', () => {
    const lines = buildEmployeeRecord({
      ...base,
      retirementFund: { ...fund, pension4001: 1_200.6, annuity4006: 32_503.08, donations4030: 1_234.56 },
      medical: { fees: 96_000, credit: 15_120, additionalCredit: 0, age65OrOlder: false, recorded: true },
    });
    expect(lines).toContain('4030,1234');
    expect(lines).toContain(`4497,${1_200 + 96_000 + 32_503 + 1_234}`);
    expect(at(lines, '4006')).toBeLessThan(at(lines, '4030'));
    expect(at(lines, '4030')).toBeLessThan(at(lines, '4497'));
    expect(at(lines, '4497')).toBeLessThan(at(lines, '4102'));
    expect(validateCertificateTaxFields(lines)).toEqual([]);
  });

  it('4497 with medical fees alone; no 4030 under R1', () => {
    const lines = buildEmployeeRecord({
      ...base,
      retirementFund: { ...fund, donations4030: 0.99 },
      medical: { fees: 12_000.75, credit: 4_000, additionalCredit: 0, age65OrOlder: false, recorded: true },
    });
    expect(at(lines, '4030')).toBe(-1);
    expect(lines).toContain('4497,12000');
  });

  it('no deduction code at all: no 4497', () => {
    expect(at(buildEmployeeRecord(base), '4497')).toBe(-1);
    expect(at(buildEmployeeRecord({ ...base, retirementFund: fund }), '4497')).toBe(-1);
  });

  it('a net negative year of donations (a reversal) reports no 4030', () => {
    const lines = buildEmployeeRecord({ ...base, retirementFund: { ...fund, pension4001: 500, donations4030: -200 } });
    expect(at(lines, '4030')).toBe(-1);
    expect(lines).toContain('4497,500');
  });
});

describe('withDeductionTotal: which codes count toward 4497 (BRS V25.3.0 p. 57: 40-, 44- and 45- codes)', () => {
  it('counts 40xx, 44xx and 45xx values, not 36xx/38xx income or 41xx tax fields, and goes after the last of them', () => {
    const record = ['3601,500000', '3810,1200', '4001,100', '4472,200', '4582,300', '4102,1000.00', '4141,354.24', '9999,9999'];
    expect(withDeductionTotal(record)).toEqual(['3601,500000', '3810,1200', '4001,100', '4472,200', '4497,600', '4582,300', '4102,1000.00', '4141,354.24', '9999,9999']);
  });

  it('leaves a record with no deduction code unchanged', () => {
    const record = ['3601,500000', '4102,1000.00', '9999,9999'];
    expect(withDeductionTotal(record)).toBe(record);
  });
});
