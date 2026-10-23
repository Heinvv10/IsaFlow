/**
 * A grid of payroll lines whose PAYE must not move when the medical scheme fees
 * tax credit is recorded (PAYE 4a follow-ups round 2, R3; §6 gate: recording
 * the credit applied must not change PAYE). The golden file beside it was
 * written from the calculator BEFORE the change (base 609f31e86) and is
 * compared figure for figure.
 *
 * Covers: tax years 2026/2027; ages under 65, 65-74, 75+; 0-4 medical
 * beneficiaries; pay from below the threshold to the top bracket; an annual
 * payment; earlier periods to date at the same and at different pay (the
 * cumulative method), an over-deduction carried, and a severance-only line.
 */
import { calculatePayrollLine } from '@/modules/accounting/services/payroll/payrollCalculator';
import type {
  EmployeeComponent, PayeYearToDate, PayrollComponent, PayrollEmployee, PayrollLineResult,
} from '@/modules/accounting/services/payroll/payrollTypes';

const comp = (code: string, extra: Partial<PayrollComponent> = {}): PayrollComponent => ({
  id: `c-${code}`, name: code, sarsSourceCode: code, componentType: 'earning',
  isTaxable: true, isUifApplicable: true, isSdlApplicable: true, ...extra,
});

const employee = (birthYear: number, beneficiaries: number): PayrollEmployee => ({
  id: 'emp-grid', companyId: 'co-grid', employeeNumber: 'G1', firstName: 'Grid', lastName: 'Line',
  employmentType: 'permanent', startDate: new Date(2015, 0, 1), dateOfBirth: new Date(birthYear, 5, 15),
  uifExcluded: false, medicalAidMainMember: beneficiaries > 0,
  medicalAidDependantsCount: Math.max(0, beneficiaries - 1),
});

export interface GridCase {
  name: string;
  run: () => PayrollLineResult;
  /** 65 or older with medical scheme fees (4005): the one case whose PAYE the additional medical credit may lower. */
  over65WithFees: boolean;
}

/** The PAYE figures a line stores or reports: everything the credit record must leave alone. */
export function payeFigures(line: PayrollLineResult): Record<string, unknown> {
  return {
    paye: line.paye, payeSplit: line.payeSplit, taxableIncome: line.taxableIncome,
    periodicTaxable: line.periodicTaxable, annualTaxable: line.annualTaxable,
    netPay: line.netPay, grossPay: line.grossPay, uif: line.uif, eti: line.eti.monthlyEti,
  };
}

/** The year-to-date fields added after the golden was written (R3): nothing recorded. */
const NO_MEDICAL_YTD = { medicalCredit: 0, additionalMedicalCredit: 0, medicalSchemeFees: 0 };

function ytdCases(): Array<[string, PayeYearToDate | undefined]> {
  return [
    ['first period', undefined],
    ['3 earlier at 20 000', { periods: 3, periodicTaxable: 60_000, annualPayments: 0, tablePaye: 12_483, ...NO_MEDICAL_YTD }],
    ['5 earlier at 9 000, a bonus', { periods: 5, periodicTaxable: 45_000, annualPayments: 9_000, tablePaye: 1_900, ...NO_MEDICAL_YTD }],
    ['over-deducted to date', { periods: 4, periodicTaxable: 24_000, annualPayments: 0, tablePaye: 9_000, ...NO_MEDICAL_YTD }],
  ];
}

export function payeIdentityGrid(): GridCase[] {
  const cases: GridCase[] = [];
  for (const taxYear of [2026, 2027]) {
    const month = 7;
    const year = taxYear - 1;
    for (const [ageLabel, birthYear] of [['age 40', taxYear - 41], ['age 66', taxYear - 67], ['age 76', taxYear - 77]] as const) {
      for (const beneficiaries of [0, 1, 2, 4]) {
        for (const salary of [3_000, 8_000, 15_000, 20_000, 45_000, 120_000]) {
          for (const bonus of [0, 10_000]) {
            for (const [ytdLabel, ytd] of ytdCases()) {
              const components: EmployeeComponent[] = [
                { component: comp('3601'), amount: salary },
                ...(bonus > 0 ? [{ component: comp('3605'), amount: bonus }] : []),
                { component: comp('4005', { componentType: 'deduction', isTaxable: false }), amount: 1_500 * Math.min(1, beneficiaries) },
              ];
              cases.push({
                name: `${taxYear} ${ageLabel} ben ${beneficiaries} salary ${salary} bonus ${bonus} ${ytdLabel}`,
                over65WithFees: ageLabel !== 'age 40' && beneficiaries > 0,
                run: () => calculatePayrollLine({
                  employee: employee(birthYear, beneficiaries), components, period: { year, month }, taxYear,
                  annualPayrollEstimate: 'defer', ytd,
                }),
              });
            }
          }
        }
      }
    }
    cases.push({
      name: `${taxYear} severance-only line, 2 beneficiaries`,
      over65WithFees: false,
      run: () => calculatePayrollLine({
        employee: employee(taxYear - 41, 2),
        components: [{ component: comp('3901', { isUifApplicable: false, isSdlApplicable: false }), amount: 50_000, directive: { id: 'd1', number: '123', paye: 9_000 } }],
        period: { year, month }, taxYear, annualPayrollEstimate: 'defer',
        ytd: { periods: 3, periodicTaxable: 45_000, annualPayments: 0, tablePaye: 6_000, ...NO_MEDICAL_YTD }, notEmployedInPeriod: true,
      }),
    });
  }
  return cases;
}
