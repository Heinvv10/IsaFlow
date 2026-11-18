import { it } from 'vitest';
import { calculateCumulativePaye } from '@/modules/accounting/services/payroll/payeCumulative';
import type { PayeYearToDate } from '@/modules/accounting/services/payroll/payrollTypes';
const r2 = (n: number) => Math.round(n * 100) / 100;
function run(periods: number, salary: number, ra: number, P = 52, F = 52) {
  let ytd: PayeYearToDate = { periods: 0, periodicTaxable: 0, annualPayments: 0, tablePaye: 0, medicalCredit: 0, additionalMedicalCredit: 0, medicalSchemeFees: 0, retirementContributions: 0, retirementDeduction: 0, retirementCapPeriods: 0 };
  let paye = 0, mtc = 0, ded = 0;
  for (let i = 0; i < periods; i++) {
    const r = calculateCumulativePaye({ taxYear: 2027, rebateAge: 40, monthlyMedicalBeneficiaries: 1, medicalSchemeFees: 0, factor: F, periodsInYear: P, regularTaxable: salary, annualPayments: 0,
      periodicRemuneration: salary, annualPaymentRemuneration: 0, retirementContributions: ra, ytd });
    paye += r.regular.monthlyPaye; mtc += r.medicalCredit; ded += r.retirementDeduction;
    ytd = { ...ytd, periods: ytd.periods + 1, retirementCapPeriods: (ytd.retirementCapPeriods ?? 0) + 1, periodicTaxable: ytd.periodicTaxable + salary, tablePaye: r2(ytd.tablePaye + r.regular.monthlyPaye),
      medicalCredit: r2(ytd.medicalCredit + r.medicalCredit), retirementContributions: (ytd.retirementContributions ?? 0) + ra, retirementDeduction: r2((ytd.retirementDeduction ?? 0) + r.retirementDeduction) };
  }
  return { paye: r2(paye), mtc: r2(mtc), ded: r2(ded) };
}
it('w53', () => {
  // eslint-disable-next-line no-console
  console.log('W53', JSON.stringify({ w52: run(52, 50_000, 10_000), w53: run(53, 50_000, 10_000), w53noRA: run(53, 50_000, 0), w52noRA: run(52, 50_000, 0),
    m12: run(12, 220_000, 45_000, 12, 365 / 30.4166), m13: run(13, 220_000, 45_000, 12, 365 / 30.4166), m13small: run(13, 20_000, 1_000, 12, 365 / 30.4166), m12small: run(12, 20_000, 1_000, 12, 365 / 30.4166), f26: run(26, 20_000, 5_000, 26, 26), f27: run(27, 20_000, 5_000, 26, 26) }));
});
