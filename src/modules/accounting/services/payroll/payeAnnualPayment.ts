/**
 * PAYE on annual payments (SARS source code 3605: bonus, leave pay on
 * resignation or encashment, and the other payments made without reference to
 * a period). Audit 2026-10-18 P3.
 *
 * SARS, Guide for Employers in respect of Employees' Tax (2027 tax year),
 * PAYE-GEN-01-G21 Revision 1, "Annual payments/bonus", p. 32–33, under
 * paragraphs 9(1) and 9(2) of the Fourth Schedule
 * (https://www.sars.gov.za/wp-content/uploads/Ops/Guides/PAYE-GEN-01-G21-Guide-for-Employers-iro-Employees-Tax-for-2027-External-Guide.pdf):
 *   "The employees' tax on an annual payment is basically determined by
 *   calculating the annual equivalent of the remuneration earned during the
 *   tax period by the employee and adding the annual payment to the result.
 *   The difference between tax on the total result (annual equivalent plus
 *   annual payment) and tax on the annual equivalent will result in employees'
 *   tax deductible from annual payment."
 * Both taxes are after rebates and medical credits (annualTaxAfterCredits), so
 * the credits reduce the regular tax once and cancel out of the difference;
 * the floor at zero is taken on each tax before the difference, which is what
 * taxes an employee below the threshold only on the part of the payment above
 * it. The whole difference is deducted in the month of payment (the guide's
 * first example); the guide's alternative of spreading it over the year is not
 * offered.
 *
 * The annual equivalent is this month's regular remuneration ×12, the basis
 * calculatePAYE has always used: the run keeps no year-to-date figures
 * (PayrollLineInput.priorPeriodCumulativePaye is unread), so a month of
 * irregular regular pay is annualised as it stands.
 */

import { annualTaxAfterCredits, calculatePAYE } from './payeEngine';
import type { PayeResult } from './payrollTypes';

export interface AnnualPaymentPayeInput {
  /** Periodic taxable remuneration for the month, after taxable deductions. */
  regularMonthlyTaxable: number;
  /** Annual payments (3605) made this month. */
  annualPayments: number;
  taxYear: number;
  /** Age on the last day of the tax year (see PayeInput.ageAtPeriodEnd). */
  rebateAge: number;
  monthlyMedicalBeneficiaries: number;
}

export interface AnnualPaymentPayeResult {
  /** The periodic PAYE on the regular remuneration, as calculatePAYE answers it. */
  regular: PayeResult;
  /** The tax on the annual payments, deducted in full this month. */
  annualPaymentPaye: number;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

export function calculateAnnualPaymentPaye(input: AnnualPaymentPayeInput): AnnualPaymentPayeResult {
  const base = {
    ageAtPeriodEnd: input.rebateAge,
    monthlyMedicalBeneficiaries: input.monthlyMedicalBeneficiaries,
    taxYear: input.taxYear,
  };
  const annualEquivalent = input.regularMonthlyTaxable * 12;
  const regular = calculatePAYE({ ...base, annualTaxableIncome: annualEquivalent });
  if (input.annualPayments <= 0) return { regular, annualPaymentPaye: 0 };

  const withPayments = annualTaxAfterCredits({ ...base, annualTaxableIncome: annualEquivalent + input.annualPayments });
  const without = annualTaxAfterCredits({ ...base, annualTaxableIncome: annualEquivalent });
  return { regular, annualPaymentPaye: round2(Math.max(0, withPayments.annualTax - without.annualTax)) };
}

/**
 * How PAYE treats an earning, by its SARS source code (audit 2026-10-18 P3,
 * decided 2026-10-20: classification by code, no new column):
 *   'annual'   — 3605, annual payment (G21 p. 32: "Reflect under code 3605").
 *   'lump_sum' — 39xx, the lump-sum codes (SARS BRS PAYE Employer
 *                Reconciliation V25.2.0, §6.4 "Lump sum codes", 3901–3926 and
 *                their foreign-service twins 3951–3957). Taxed only at the
 *                figures on a SARS directive, never by the tables.
 *   'periodic' — every other code, and no code: annualised ×12.
 */
export type PayeTreatment = 'periodic' | 'annual' | 'lump_sum';

export function payeTreatment(sarsSourceCode: string | null | undefined): PayeTreatment {
  const code = (sarsSourceCode ?? '').trim();
  if (code === '3605') return 'annual';
  if (/^39\d\d$/.test(code)) return 'lump_sum';
  return 'periodic';
}
