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
 * period of any employment), the result is the per-period result on the same F
 * (with F = 12 it is exactly the tables' ×12).
 * The annual-payment part follows G21 p. 32–33: tax(AE + payment) − tax(AE),
 * AE being "the annual equivalent of the remuneration earned during the tax
 * period" (whole difference this month; the guide's alternative of spreading
 * it over the remaining periods is not offered).
 *
 * At period n of the tax year (n = periods with periodic pay so far, this one
 * included; P = periodic taxable remuneration to date; A = annual payments to
 * date, A' = those before this period; F = the annualisation factor,
 * annualisationFactor.ts: 365 ÷ 30.4166 a month, Sage's days basis, ruled as
 * vendor parity (wave-6 ruling 5), not G21 p. 8's × 12):
 *   AE = P × F ÷ n
 *   liability to date = tax(AE) × n ÷ F + [tax(AE + A) − tax(AE)]
 *   table PAYE now    = liability to date − table PAYE already deducted,
 *                       floored at nil (an over-deduction is carried, not
 *                       refunded: no SARS guide requires an in-year refund)
 *   of which annual   = tax(AE + A) − tax(AE + A')   (earlier annual payments
 *                       stay in the base, so a later one is taxed on top)
 * "tax" is annualTaxAfterCredits: the rebates are annual figures, pro-rated by
 * the same n ÷ F. The medical credits are statutory amounts a month (s6A, and
 * s6B's three times the MTC), a period ratio, not an annualisation: the part
 * used on the AE is weighted n ÷ 12, so tax(AE) × n ÷ F above is, exactly,
 * (tax(AE) + C) × n ÷ F − min(C × n ÷ 12, (tax(AE) + C) × n ÷ F), C = the
 * credits used on the AE, MTC first (coordinator ruling 2026-11-17). Directive PAYE (lump
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
 * liability is: used(AE) × n ÷ 12 (never past the tax after rebates to date,
 * MTC first) + [used(AE + A) − used(AE)]. So the lines of
 * a year add up to the credit inside the year's liability, a line never
 * records a credit its PAYE did not use, and a constant year records the
 * monthly credit each month. The record follows the liability, so it moves as
 * the liability does: a line after earlier lines with no record (written
 * before 926) carries their credit too, and a credit the liability no longer
 * holds (dependants removed mid-year, or pay falling where the credit is
 * capped) is a negative record. A line with neither periodic pay nor an
 * annual payment takes nothing from the tables; it can reverse an earlier
 * credit but cannot grow one. Recording it changes no PAYE figure (tests/unit/services/payroll/
 * payeMedicalCreditIdentity.test.ts).
 *
 * The additional medical expenses tax credit for 65 and older (section
 * 6B(3)(a)(i), payeEngine.computeAdditionalMedicalCredit; Hein 2026-10-23)
 * is an annual figure like the others: 33,3% × (annual fees − 3 × annual
 * MTC). The annual fees are the signed fees to date (deductions coded 4005,
 * ytd included), netted before the total is floored at zero and annualised
 * over the same n as the pay on twelve months, fees × 12 ÷ n, so the credit
 * inside the liability to date, × n ÷ 12, is 33,3% × (fees − 3 × MTC × n ÷ 12):
 * the section applied to the year so far. With no periodic pay yet (n = 0, an
 * annual payment alone) the fees to date are taken as they stand. It changes
 * PAYE only for an employee 65 or older whose fees exceed three times the MTC
 * (tests/integration/p4fu-r2b-amtc-identity.int.test.ts); a month calculated
 * after earlier months that had no credit (lines before migration 926: their
 * fees are read from the breakdown) takes the whole credit to date at once,
 * floored at nil and carried like any over-deduction. Its record (4120,
 * `additionalMedicalCredit`) follows the same rule as the MTC's.
 *
 * Retirement fund contributions (PAYE 4c, retirementFund.ts): the deduction
 * comes off the annual equivalent before the tables, rebates and credits. C =
 * contributions to date (deductions coded 4001/4003/4006, ytd included),
 * with signed correction lines netted before the cumulative total is floored
 * at zero (the same applies to donations),
 * annualised over the same n as the pay (C × F ÷ n; with n = 0, as they
 * stand); remuneration = AE + all annual payments to date, both BEFORE the
 * deduction (the s11F base); D = allowedRetirementDeduction(C × F ÷ n,
 * remuneration). AE becomes AE − D, so the liability to date is tax(AE − D) ×
 * n ÷ F + [tax(AE − D + A) − tax(AE − D)]: the deduction weighted n ÷ F, the
 * proviso that limits the cap to the period paid (G21 2027 p. 10). At n = 12
 * the year's liability is tax(remuneration × F ÷ 12 − D) × 12 ÷ F, within cents
 * of the s11F year; the cap is cap × F ÷ 12 on this scale, so the cap to date
 * is cap × n ÷ 12, G21 p. 10's period ratio, and reaches the cap. Should D
 * exceed AE (an annual payment over 2.6 × the annual pay), the excess comes off
 * the annual payments in full, never below nil and never past the contributions
 * to date or the cap × n ÷ 12 (each less the AE part × n ÷ F). Donations (4030, s18A) are added back to the
 * base (G21 2027 p. 10). The line records the deduction inside
 * the liability to date ((D − excess) × n ÷ F + excess) less what the earlier
 * lines recorded (ytd.retirementDeduction), as the credits are recorded. A
 * no-pay correction can reverse an earlier record, but cannot grow the
 * deduction without periodic pay or an annual payment.
 * periodicTaxable / annualPayments (in and in ytd) are remuneration BEFORE the
 * deduction.
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
import { retirementDeductionLimits } from './retirementFund';
import { getTaxYearConfig } from './taxTables';
import type { CumulativePayeInput, CumulativePayeResult, CumulativePayeTrace } from './payeCumulativeTypes';

export type { CumulativePayeInput, CumulativePayeResult, CumulativePayeTrace } from './payeCumulativeTypes';

const round2 = (n: number): number => Math.round(n * 100) / 100;

export function calculateCumulativePaye(input: CumulativePayeInput): CumulativePayeResult {
  const { ytd, factor: F } = input;
  // P: the statutory periods in a year (12 a month), for the period ratios statute fixes (annualisationFactor.ts). Those
  // ratios never pass a whole year: a 53rd week or a 13th line in a tax year counts as the year (review #1578 M).
  const P = input.periodsInYear;
  const ratio = (n: number) => Math.min(n, P) / P;
  const hasPeriodic = input.periodicRemuneration > 0;
  const periods = ytd.periods + (hasPeriodic ? 1 : 0);
  const feesToDate = Math.max(0, ytd.medicalSchemeFees + input.medicalSchemeFees);
  // The credits are statutory amounts a month (s6A "in respect of each month"; s6B's three times the MTC): they stay on
  // twelve months, fees × 12 ÷ n, and come off the liability weighted n ÷ 12, never ÷ F (coordinator ruling 2026-11-17).
  const annualMedicalSchemeFees = periods > 0 ? (feesToDate * P) / periods : feesToDate;
  const base = {
    ageAtPeriodEnd: input.rebateAge, monthlyMedicalBeneficiaries: input.monthlyMedicalBeneficiaries, taxYear: input.taxYear,
    annualMedicalSchemeFees,
  };
  const credits = (income: number) => annualTaxAfterCredits({ ...base, annualTaxableIncome: income });

  const periodic = ytd.periodicTaxable + Math.max(0, input.regularTaxable);
  const annualEquivalent = periods > 0 ? (periodic * F) / periods : 0;
  const annualBefore = Math.max(0, ytd.annualPayments);
  const annualNow = Math.max(0, input.annualPayments);

  // The retirement fund deduction, on annual figures before it (see the header).
  const contributions = Math.max(0, (ytd.retirementContributions ?? 0) + (input.retirementContributions ?? 0));
  const annualise = (toDate: number) => (periods > 0 ? (toDate * F) / periods : toDate);
  // The 27.5% base is taxable income "before allowing any deduction under ss11F, 6quat(1C) and 18A" (G21 (2027)
  // p. 10): donations (4030), deducted from regularTaxable, are added back to it.
  const donations = Math.max(0, (ytd.donations ?? 0) + (input.donations ?? 0));
  const annualisedContributions = annualise(contributions);
  const deductionBase = annualEquivalent + annualise(donations) + annualBefore + annualNow;
  // The statutory cap is a year's amount: on the annual-equivalent scale it is cap × F ÷ 12, so the part off periodic pay
  // (weighted n ÷ F below) reaches cap × n ÷ 12, G21 (2027) Rev 1 p. 10's period ratio (coordinator ruling 2026-11-17).
  const limits = retirementDeductionLimits(annualisedContributions, deductionBase, input.taxYear, F / P);
  const deduction = limits.allowed;
  // The part off the annual equivalent is weighted n ÷ 12; the rest comes off the annual payments in full, but
  // never past what was contributed to date (review #891: an unlimited excess deducted more than was paid), nor
  // past the cap × n ÷ 12, "at any time during the year" (G21 (2027) p. 10; review #891 round 2). A period paid
  // only an annual payment counts as one.
  // Split on the pay before donations, so the deduction is the same with or without one. A donation then has less
  // periodic pay to come off than the deduction took, and that part comes off the annual payments (donationSpill).
  // Only donations under the s18A rule (migration 959), which come off periodic pay; an older line's may not have.
  const periodicDonations = Math.max(0, (ytd.donationDeduction ?? 0) + (input.donations ?? 0));
  // What can come off the annual equivalent: itself, plus the periodic donations a year the deduction's base added back.
  const offPeriodicCeiling = annualEquivalent + (periods > 0 ? annualise(periodicDonations) : 0);
  const offPeriodic = Math.min(deduction, offPeriodicCeiling);
  const capPeriods = (ytd.retirementCapPeriods ?? ytd.periods)
    + (hasPeriodic || input.annualPaymentRemuneration > 0 ? 1 : 0);
  // A STATUTORY PERIOD RATIO, NOT AN ANNUALISATION (coordinator ruling 2026-11-17: statute over unproven parity): the cap
  // to date is cap × n ÷ 12 (G21 (2027) Rev 1 p. 10, "the same ratio as the period ... bears to a whole year"), never ÷ F,
  // so twelve months reach exactly R430 000. Pinned by payeAnnualisation.test.ts ("twelve equal months at the cap").
  const capToDate = (getTaxYearConfig(input.taxYear).retirementDeductionCap * ratio(Math.max(capPeriods, 1)));
  // The deduction off periodic pay to date: weighted n ÷ F as the liability is, but never past the cap to date (review
  // #1578 round 2, coordinator ruling: bound it first, then tax the AE less it). Past P periods (a 27th fortnight, a 53rd
  // week, a 13th line) a deduction under the cap is recorded and taxed in full; one at the cap stops at the cap both ways.
  const unboundedToDate = (offPeriodic * periods) / F;
  const periodicToDate = Math.min(unboundedToDate, capToDate);
  const offPeriodicTaxed = periodicToDate < unboundedToDate ? (periodicToDate * F) / periods : offPeriodic;
  const offAnnualLimits = {
    // On the year's scale, as the cap and the contributions to date are (review #1578 L2): the part off periodic pay over a
    // whole year is offPeriodic × P ÷ F, so a year's deduction is D exactly (with F = P, deduction − offPeriodic as before).
    deductionLeft: deduction - (offPeriodic * P) / F, annualPayments: annualBefore + annualNow,
    contributionsLeft: contributions - periodicToDate, capLeft: capToDate - periodicToDate,
  };
  const offAnnual = Math.max(0, Math.min(offAnnualLimits.deductionLeft, offAnnualLimits.annualPayments,
    offAnnualLimits.contributionsLeft, offAnnualLimits.capLeft));
  const taxedAE = Math.max(0, annualEquivalent - offPeriodicTaxed);
  const donationSpill = (Math.max(0, offPeriodic - annualEquivalent) * periods) / F;
  const annualAll = Math.max(0, annualBefore + annualNow - offAnnual - donationSpill);
  const annualEarlier = Math.max(0, annualBefore - offAnnual - donationSpill);

  const regularInfo = calculatePAYE({ ...base, annualTaxableIncome: taxedAE });
  const atAE = credits(taxedAE);
  const atAll = credits(taxedAE + annualAll);
  const atEarlier = credits(taxedAE + annualEarlier);
  // F de-annualises the tax after rebates on the annual equivalent; the medical credits it used are monthly amounts
  // (s6A; s6B's three times the MTC) and come off × n ÷ 12, a period ratio (coordinator ruling 2026-11-17), in the
  // order the tax takes them and never past that tax, so a line never records a credit its PAYE did not use.
  const afterRebatesToDate = ((atAE.annualTax + atAE.medicalCreditUsed + atAE.additionalMedicalCreditUsed) * periods) / F;
  const mtcOnAE = Math.min(atAE.medicalCreditUsed * ratio(periods), afterRebatesToDate);
  const amtcOnAE = Math.min(atAE.additionalMedicalCreditUsed * ratio(periods), afterRebatesToDate - mtcOnAE);
  const traceOf = (paid: boolean, liability: number, due: number, annualDue: number): CumulativePayeTrace => ({
    paid, factor: F, periodsInYear: P, periods, ytdPeriodicTaxable: ytd.periodicTaxable, regularTaxable: Math.max(0, input.regularTaxable),
    periodicToDate: periodic, annualEquivalent, contributionsToDate: contributions, donationsToDate: donations,
    annualisedContributions, deductionBase, shareOfRemuneration: limits.shareOfRemuneration, annualDeduction: deduction, annualCap: limits.cap, offPeriodicCeiling,
    offPeriodic, offAnnual, donationSpill, offAnnualLimits, hasPeriodic, capPeriods: Math.max(capPeriods, 1), capToDate, deductionOffPeriodicToDate: periodicToDate,
    taxedAnnualEquivalent: taxedAE, offPeriodicTaxed,
    annualBefore, annualNow, annualAll, annualEarlier, atAE, atAll, atEarlier, afterRebatesToDate, creditsOnAEToDate: mtcOnAE + amtcOnAE,
    liability, ytdTablePaye: ytd.tablePaye, due, annualDue,
  });
  // A credit inside the liability to date: its part on the annual equivalent (above), the annual payments' part in full.
  const mtcToDate = mtcOnAE + atAll.medicalCreditUsed - atAE.medicalCreditUsed;
  const amtcToDate = amtcOnAE + atAll.additionalMedicalCreditUsed - atAE.additionalMedicalCreditUsed;
  // A period with neither periodic pay nor an annual payment deducts nothing
  // from the tables. It can still reverse an earlier retirement deduction or
  // medical credit when signed corrections reduce the cumulative entitlement.
  if (!hasPeriodic && annualNow <= 0) {
    return {
      regular: { ...regularInfo, monthlyPaye: 0 }, annualPaymentPaye: 0, periods, annualEquivalent,
      medicalCredit: Math.min(0, round2(mtcToDate - ytd.medicalCredit)),
      additionalMedicalCredit: Math.min(0, round2(amtcToDate - ytd.additionalMedicalCredit)),
      retirementDeduction: Math.min(0, round2(periodicToDate + offAnnual - (ytd.retirementDeduction ?? 0))),
      retirementOffPeriodicToDate: periodicToDate,
      trace: traceOf(false, 0, 0, 0),
    };
  }
  const taxAE = atAE.annualTax;
  const taxAll = atAll.annualTax;
  const liability = afterRebatesToDate - mtcOnAE - amtcOnAE + (taxAll - taxAE);
  const due = Math.max(0, round2(liability - ytd.tablePaye));
  const annualDue = Math.max(0, taxAll - atEarlier.annualTax);
  const annualPaymentPaye = round2(Math.min(due, annualDue));
  return {
    regular: { ...regularInfo, monthlyPaye: round2(due - annualPaymentPaye) },
    annualPaymentPaye,
    periods,
    annualEquivalent: round2(annualEquivalent),
    medicalCredit: round2(mtcToDate - ytd.medicalCredit),
    additionalMedicalCredit: round2(amtcToDate - ytd.additionalMedicalCredit),
    retirementDeduction: round2(periodicToDate + offAnnual - (ytd.retirementDeduction ?? 0)),
    retirementOffPeriodicToDate: periodicToDate,
    trace: traceOf(true, liability, due, annualDue),
  };
}
