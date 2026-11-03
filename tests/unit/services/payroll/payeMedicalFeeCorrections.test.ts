/**
 * PAYE 4c follow-up: signed medical scheme fee corrections.
 *
 * SARS PAYE-GEN-01-G21 (2027) Rev 1 p. 4 gives the monthly MTC as
 * R376 for the taxpayer, R376 for the first dependant and R254 for each
 * additional dependant. These increased from 2026's R364/R364/R246.
 */
import { describe, expect, it } from 'vitest';
import { calculateCumulativePaye } from '@/modules/accounting/services/payroll/payeCumulative';
import type { PayeYearToDate } from '@/modules/accounting/services/payroll/payrollTypes';

const NONE: PayeYearToDate = {
  periods: 0,
  periodicTaxable: 0,
  annualPayments: 0,
  tablePaye: 0,
  medicalCredit: 0,
  additionalMedicalCredit: 0,
  medicalSchemeFees: 0,
};

const round2 = (value: number) => Math.round(value * 100) / 100;

interface Period {
  salary: number;
  fees: number;
  age?: number;
  beneficiaries?: number;
}

function period(ytd: PayeYearToDate, input: Period) {
  const result = calculateCumulativePaye({
    taxYear: 2027,
    rebateAge: input.age ?? 40,
    monthlyMedicalBeneficiaries: input.beneficiaries ?? 1,
    regularTaxable: input.salary,
    annualPayments: 0,
    medicalSchemeFees: input.fees,
    ytd,
  });
  const tablePaye = round2(result.regular.monthlyPaye + result.annualPaymentPaye);
  const next: PayeYearToDate = {
    ...ytd,
    periods: result.periods,
    periodicTaxable: round2(ytd.periodicTaxable + input.salary),
    tablePaye: round2(ytd.tablePaye + tablePaye),
    medicalCredit: round2(ytd.medicalCredit + result.medicalCredit),
    additionalMedicalCredit: round2(ytd.additionalMedicalCredit + result.additionalMedicalCredit),
    medicalSchemeFees: round2(ytd.medicalSchemeFees + input.fees),
  };
  return { result, next, tablePaye };
}

describe('signed medical scheme fee corrections', () => {
  it('allows the normal fixed monthly s6A credit when scheme fees are paid', () => {
    // tax(360 000) = 73 992; less primary rebate 17 820 and MTC 4 512
    // gives annual tax 51 660, or PAYE 4 305 for the first month.
    const march = period(NONE, { salary: 30_000, fees: 500 });

    expect([
      march.result.medicalCredit,
      march.result.additionalMedicalCredit,
      march.tablePaye,
      march.next.medicalSchemeFees,
    ]).toEqual([376, 0, 4_305, 500]);
  });

  it('nets a negative correction in a paid month, reducing total medical credits and raising PAYE', () => {
    const march = period(NONE, { salary: 30_000, fees: 3_000, age: 67 });
    const april = period(march.next, { salary: 30_000, fees: -1_000, age: 67 });

    // March s6B is 33.3% x (36 000 - 3 x 4 512) = R7 480.512, or R623.38.
    // The correction leaves R2 000 over two periods, annualised to R12 000,
    // below 3 x MTC, so s6B reverses. Liability is R41 895 x 2/12 = R6 982.50;
    // less March's R2 867.87 PAYE leaves R4 114.63.
    expect([
      april.next.periods,
      april.next.medicalSchemeFees,
      april.result.medicalCredit,
      april.result.additionalMedicalCredit,
      april.tablePaye,
    ]).toEqual([2, 2_000, 376, -623.38, 4_114.63]);
    expect(april.tablePaye).toBeGreaterThan(march.tablePaye);
  });

  it('records a credit reversal in a correction-only no-pay month without advancing periods', () => {
    const march = period(NONE, { salary: 30_000, fees: 3_000, age: 67 });
    const correction = period(march.next, { salary: 0, fees: -3_000, age: 67 });

    expect([
      correction.next.periods,
      correction.next.medicalSchemeFees,
      correction.result.medicalCredit,
      correction.result.additionalMedicalCredit,
      correction.tablePaye,
    ]).toEqual([1, 0, 0, -623.38, 0]);
  });

  it('does not grow a credit in a positive fee-only no-pay month', () => {
    const march = period(NONE, { salary: 30_000, fees: 3_000, age: 67 });
    const feesOnly = period(march.next, { salary: 0, fees: 1_000, age: 67 });

    expect([
      feesOnly.next.periods,
      feesOnly.next.medicalSchemeFees,
      feesOnly.result.medicalCredit,
      feesOnly.result.additionalMedicalCredit,
      feesOnly.tablePaye,
    ]).toEqual([1, 4_000, 0, 0, 0]);
  });

  it('adjusts the 65+ s6B credit consistently when corrected fees remain above three times MTC', () => {
    const march = period(NONE, { salary: 30_000, fees: 3_000, age: 67 });
    const april = period(march.next, { salary: 30_000, fees: -500, age: 67 });

    // The correction leaves fees to date of R2 500, annualised over two
    // periods to R15 000. s6B becomes 33.3% x (15 000 - 3 x 4 512)
    // = R487.512 annually, R81.252 to date; less March's R623.38 record gives
    // a R542.13 reversal. PAYE to date is R6 901.248; less R2 867.87 paid.
    expect([
      march.result.medicalCredit,
      march.result.additionalMedicalCredit,
      march.tablePaye,
    ]).toEqual([376, 623.38, 2_867.87]);
    expect([
      april.next.medicalSchemeFees,
      april.result.medicalCredit,
      april.result.additionalMedicalCredit,
      april.tablePaye,
    ]).toEqual([2_500, 376, -542.13, 4_033.38]);
  });
});
