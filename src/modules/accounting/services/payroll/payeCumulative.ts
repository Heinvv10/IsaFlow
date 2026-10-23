/**
 * Cumulative (run-to-date) PAYE for periodic pay, and the annual-payment
 * method on top of it. PAYE 4a follow-ups G4.
 *
 * THIS IS A BUSINESS DECISION, NOT A SARS PRESCRIPTION (Hein, 2026-10-22, at
 * a confirmation gate, told the following): SARS prescribes the per-period
 * deduction tables for an employee employed for the whole year. No SARS guide
 * prescribes this method, and none authorises it for such an employee:
 * - PAYE-GEN-01-G21 (2027) Rev 1 p. 8 ("Annual equivalent calculation",
 *   paragraphs 9(1)/(2) of the Fourth Schedule) gives the formula used below,
 *   AE = remuneration × periods in year ÷ periods worked, tax × periods ÷ 12,
 *   but says an annual equivalent "need only be determined when an employee's
 *   tax period is shorter than a full tax year" (joiners, leavers);
 * - PAYE-GEN-01-G01 Rev 16 p. 5 accepts other computer programs only where
 *   they "render the same results" as the statutory rates and SARS's
 *   instructions are followed. This method does NOT render the same monthly
 *   result when periodic pay changes during the year: it spreads the change
 *   over the rest of the year (e.g. a R20 000 → R30 000 increase: 4 477 in
 *   the first month, where the tables give 4 681), so it can under-deduct in
 *   such a month, and the employer is liable for an under-deduction. Hein
 *   accepted that risk for a year-end deduction equal to the annual liability.
 * Where pay does not change (every period at the same pay, and the first
 * period of any employment), the result is exactly the per-period ×12 result.
 * The annual-payment part follows G21 p. 32–33: tax(AE + payment) − tax(AE),
 * AE being "the annual equivalent of the remuneration earned during the tax
 * period" (whole difference this month; the guide's alternative of spreading
 * it over the remaining periods is not offered).
 *
 * At period n of the tax year (n = periods with periodic pay so far, this one
 * included; P = periodic taxable remuneration to date; A = annual payments to
 * date, A' = those before this period):
 *   AE = P × 12 ÷ n
 *   liability to date = tax(AE) × n ÷ 12 + [tax(AE + A) − tax(AE)]
 *   table PAYE now    = liability to date − table PAYE already deducted,
 *                       floored at nil (an over-deduction is carried, not
 *                       refunded: no SARS guide requires an in-year refund)
 *   of which annual   = tax(AE + A) − tax(AE + A')   (earlier annual payments
 *                       stay in the base, so a later one is taxed on top)
 * "tax" is annualTaxAfterCredits: rebates and medical credits are annual
 * figures, so they are pro-rated by the same n ÷ 12. Directive PAYE (lump
 * sums) is outside all of it. Figures use the statutory rate table, not
 * SARS's deduction tables (PAYE-GEN-01-G01-A04 2027: R500 income bands, each
 * taxed at its midpoint, e.g. R335 801–336 301 → 49 945 = tax(336 051)), so
 * they differ by a few rand either way from the guide's worked examples
 * (G21 p. 8: R16 156 printed for 188 571, the band 188 507–189 007; the
 * statutory table gives R16 122.86).
 *
 * The medical scheme fees tax credit a line records (`medicalCredit`, stored
 * in payroll_run_lines.medical_credit, migration 926, for the e@syFile 4116;
 * PAYE 4a follow-ups round 2, R3) is the credit INSIDE the liability to date
 * less the credits the employee's earlier lines of the tax year recorded
 * (ytd.medicalCredit). Inside the liability the credit is what "tax" took off,
 * used(x) = min(annual credit, tax after rebates on x), weighted as the
 * liability is: used(AE) × n ÷ 12 + [used(AE + A) − used(AE)]. So the lines of
 * a year add up to the credit inside the year's liability, a line never
 * records a credit its PAYE did not use, and a constant year records the
 * monthly credit each month. The record follows the liability, so it moves as
 * the liability does: a line after earlier lines with no record (written
 * before 926) carries their credit too, and a credit the liability no longer
 * holds (dependants removed mid-year, or pay falling where the credit is
 * capped) is a negative record. A line with neither periodic pay nor an
 * annual payment takes nothing from the tables and records nil. Recording it
 * changes no PAYE figure (tests/unit/services/payroll/
 * payeMedicalCreditIdentity.test.ts). The additional medical expenses tax
 * credit for 65 and older (4120) is not computed by IsaFlow.
 *
 * A month's PAYE depends on which earlier months are approved when it is
 * calculated (the year-to-date reads approved/paid runs only): a month
 * calculated while the previous one is still a draft, or before an earlier
 * month is reopened and re-approved, is not refreshed; the next month's
 * calculation trues it up. A month calculated after LATER months were approved
 * warns (PAYE_LATER_PERIODS_APPROVED): if February is among them, the year
 * stays short until the assessment.
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
  /** The medical scheme fees tax credit this line records (see the header). */
  medicalCredit: number;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
const PERIODS_IN_YEAR = 12;

export function calculateCumulativePaye(input: CumulativePayeInput): CumulativePayeResult {
  const { ytd } = input;
  const base = { ageAtPeriodEnd: input.rebateAge, monthlyMedicalBeneficiaries: input.monthlyMedicalBeneficiaries, taxYear: input.taxYear };
  const tax = (income: number) => annualTaxAfterCredits({ ...base, annualTaxableIncome: income }).annualTax;
  const used = (income: number) => annualTaxAfterCredits({ ...base, annualTaxableIncome: income }).medicalCreditUsed;

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
    return { regular: { ...regularInfo, monthlyPaye: 0 }, annualPaymentPaye: 0, periods, annualEquivalent, medicalCredit: 0 };
  }
  const taxAE = tax(annualEquivalent);
  const taxAll = tax(annualEquivalent + annualBefore + annualNow);
  const liability = (taxAE * periods) / PERIODS_IN_YEAR + (taxAll - taxAE);
  const due = Math.max(0, round2(liability - ytd.tablePaye));
  const annualDue = Math.max(0, taxAll - tax(annualEquivalent + annualBefore));
  const annualPaymentPaye = round2(Math.min(due, annualDue));
  const usedAE = used(annualEquivalent);
  const creditToDate = (usedAE * periods) / PERIODS_IN_YEAR + (used(annualEquivalent + annualBefore + annualNow) - usedAE);
  return {
    regular: { ...regularInfo, monthlyPaye: round2(due - annualPaymentPaye) },
    annualPaymentPaye,
    periods,
    annualEquivalent: round2(annualEquivalent),
    medicalCredit: round2(creditToDate - ytd.medicalCredit),
  };
}
