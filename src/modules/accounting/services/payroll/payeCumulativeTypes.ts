/**
 * The input, result and trace shapes of the cumulative PAYE (payeCumulative.ts, whose header gives the formula).
 * Moved out of payeCumulative.ts unchanged (wave-6 AN, refactor(split)).
 */

import type { AnnualTaxAfterCredits } from './payeEngine';
import type { PayeResult, PayeYearToDate } from './payrollTypes';

export interface CumulativePayeInput {
  /** This period's periodic taxable remuneration, after allowed donations (the only deduction taken before this). */
  regularTaxable: number;
  /** This period's annual payments (3605), after any allowed donation in excess of periodic pay. */
  annualPayments: number;
  /** Taxable periodic earnings before any deduction, used only to decide whether this is a pay period. */
  periodicRemuneration: number;
  /** Taxable annual payments before any deduction, used only to advance the pro-rated s11F cap period. */
  annualPaymentRemuneration: number;
  /** Earlier periods of the tax year (declarable runs, before this period). */
  ytd: PayeYearToDate;
  taxYear: number;
  rebateAge: number;
  monthlyMedicalBeneficiaries: number;
  /** This period's signed medical scheme fees paid through payroll (deductions coded 4005). */
  medicalSchemeFees: number;
  /** This period's employee retirement fund contributions (deductions coded 4001/4003/4006); absent = none. */
  retirementContributions?: number;
  /** This period's donations deducted as taxable deductions (4030, s18A), inside regularTaxable; absent = none. */
  donations?: number;
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
  /** The 65+ additional medical expenses tax credit this line records (see the header). */
  additionalMedicalCredit: number;
  /** The retirement fund deduction this line records (see the header). */
  retirementDeduction: number;
  /** The retirement fund deduction to date that came off periodic pay, for the room a donation has (payrollLinePaye). */
  retirementOffPeriodicToDate: number;
  /** Every intermediate step as the engine held it, for the explanation (payrollExplain), which never recomputes one. */
  trace: CumulativePayeTrace;
}

/** The figures of the formula in the header, unrounded unless the engine rounds them. */
export interface CumulativePayeTrace {
  /** False: neither periodic pay nor an annual payment this period, so the tables took nothing. */
  paid: boolean;
  periods: number; ytdPeriodicTaxable: number; regularTaxable: number; periodicToDate: number; annualEquivalent: number;
  contributionsToDate: number; donationsToDate: number; annualisedContributions: number; deductionBase: number;
  /** The s11F deduction on annual figures, the part off the annual equivalent, and the part off the annual payments. */
  /** 27.5% × deductionBase (one of the three limits); the deduction allowed a year; and what can come off the annual
   *  equivalent (it, plus periodic donations a year): offPeriodic is the lesser of the last two. */
  shareOfRemuneration: number; annualDeduction: number; offPeriodicCeiling: number;
  offPeriodic: number; offAnnual: number; donationSpill: number;
  /** This period has periodic pay (it counts in n); the periods the cap to date is for; the cap to date; the deduction off periodic pay to date. */
  hasPeriodic: boolean; capPeriods: number; capToDate: number; deductionOffPeriodicToDate: number;
  /** offAnnual is the least of these (never below nil): the deduction left, the annual payments, contributions and the cap to date, each less the part off periodic pay to date. */
  offAnnualLimits: { deductionLeft: number; annualPayments: number; contributionsLeft: number; capLeft: number };
  taxedAnnualEquivalent: number; annualBefore: number; annualNow: number; annualAll: number; annualEarlier: number;
  /** Tax on the annual equivalent, with all annual payments to date, and with the earlier ones only. */
  atAE: AnnualTaxAfterCredits; atAll: AnnualTaxAfterCredits; atEarlier: AnnualTaxAfterCredits;
  liability: number; ytdTablePaye: number; due: number; annualDue: number;
}
