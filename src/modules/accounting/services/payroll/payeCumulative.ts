/**
 * Cumulative (run-to-date) PAYE for periodic pay, and the annual-payment
 * method on top of it. PAYE 4a follow-ups G4; method decided by Hein
 * 2026-10-22 (build cumulative), on these sources:
 *
 * - SARS PAYE-GEN-01-G21 (2027 tax year) Rev 1, "Annual equivalent
 *   calculation", p. 8, under paragraphs 9(1) and 9(2) of the Fourth Schedule:
 *   annual equivalent = total remuneration received × total pay periods in the
 *   tax year ÷ total pay periods worked; the employee is liable for the tax on
 *   it "divided by the ratio which a full year bears to the periods" worked
 *   (worked example: R110 000 over 7 months → R188 571; R16 156 ÷ 12 × 7).
 * - The same guide, "Annual payments/bonus", p. 32–33: the tax on an annual
 *   payment is tax(annual equivalent + payment) − tax(annual equivalent),
 *   where the annual equivalent is "of the remuneration earned during the tax
 *   period".
 * - SARS PAYE-GEN-01-G01 Rev 16, "Different versions of tax deduction
 *   programs", p. 5: a payroll program may use the statutory rates provided
 *   "the results are within the provisions of this Act".
 *
 * So, at period n of the tax year (n = periods with periodic pay so far,
 * this one included; P = periodic taxable remuneration to date; A = annual
 * payments to date, A' = those before this period):
 *   AE = P × 12 ÷ n
 *   liability to date = tax(AE) × n ÷ 12 + [tax(AE + A) − tax(AE)]
 *   table PAYE now    = liability to date − table PAYE already deducted,
 *                       floored at nil (an over-deduction is carried, not
 *                       refunded: no SARS guide requires an in-year refund)
 *   of which annual   = tax(AE + A) − tax(AE + A')   (earlier annual payments
 *                       stay in the base, so a later one is taxed on top)
 * "tax" is annualTaxAfterCredits: rebates and medical credits are annual
 * figures, so they are pro-rated by the same n ÷ 12. In the first period, and
 * for a flat salary in every period, this is exactly the ×12 result. Directive
 * PAYE (lump sums) is outside all of it.
 *
 * It differs from SARS's per-period tables (G21 p. 33 production-bonus
 * example) when pay changes in the year: the change is spread over the rest of
 * the year rather than taxed as if it lasted twelve months. Deliberate (Hein,
 * 2026-10-22): the year-end deduction then equals the annual liability.
 */

import { annualTaxAfterCredits, calculatePAYE } from './payeEngine';
import type { PayeResult, PayeYearToDate } from './payrollTypes';

export interface CumulativePayeInput {
  /** This period's periodic taxable remuneration, after taxable deductions. */
  regularTaxable: number;
  /** This period's annual payments (3605), after any excess taxable deductions. */
  annualPayments: number;
  /** Earlier periods of the tax year (declarable runs, before this period). */
  ytd: PayeYearToDate;
  taxYear: number;
  rebateAge: number;
  monthlyMedicalBeneficiaries: number;
}

export interface CumulativePayeResult {
  /** The regular calculation on the annual equivalent, `monthlyPaye` = this period's regular PAYE. */
  regular: PayeResult;
  annualPaymentPaye: number;
  /** Periods with periodic pay to date, this one included (the n of the formula). */
  periods: number;
  annualEquivalent: number;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
const PERIODS_IN_YEAR = 12;

export function calculateCumulativePaye(input: CumulativePayeInput): CumulativePayeResult {
  const { ytd } = input;
  const base = { ageAtPeriodEnd: input.rebateAge, monthlyMedicalBeneficiaries: input.monthlyMedicalBeneficiaries, taxYear: input.taxYear };
  const tax = (income: number) => annualTaxAfterCredits({ ...base, annualTaxableIncome: income }).annualTax;

  const hasPeriodic = input.regularTaxable > 0;
  const periods = ytd.periods + (hasPeriodic ? 1 : 0);
  const periodic = ytd.periodicTaxable + Math.max(0, input.regularTaxable);
  const annualEquivalent = periods > 0 ? (periodic * PERIODS_IN_YEAR) / periods : 0;
  const annualBefore = Math.max(0, ytd.annualPayments);
  const annualNow = Math.max(0, input.annualPayments);

  const regularInfo = calculatePAYE({ ...base, annualTaxableIncome: annualEquivalent });
  // A period with neither periodic pay nor an annual payment (a severance-only
  // line) deducts nothing from the tables: there is nothing to deduct it from.
  if (!hasPeriodic && annualNow <= 0) {
    return { regular: { ...regularInfo, monthlyPaye: 0 }, annualPaymentPaye: 0, periods, annualEquivalent };
  }
  const taxAE = tax(annualEquivalent);
  const liability = (taxAE * periods) / PERIODS_IN_YEAR + (tax(annualEquivalent + annualBefore + annualNow) - taxAE);
  const due = Math.max(0, round2(liability - ytd.tablePaye));
  const annualDue = Math.max(0, tax(annualEquivalent + annualBefore + annualNow) - tax(annualEquivalent + annualBefore));
  const annualPaymentPaye = round2(Math.min(due, annualDue));
  return {
    regular: { ...regularInfo, monthlyPaye: round2(due - annualPaymentPaye) },
    annualPaymentPaye,
    periods,
    annualEquivalent: round2(annualEquivalent),
  };
}
