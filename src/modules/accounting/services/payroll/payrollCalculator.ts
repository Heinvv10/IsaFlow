import { formatMoney } from '@/lib/money/formatMoney';
import { getAge } from './payeEngine';
import { normaliseSarsCode, payeTreatment } from './payeAnnualPayment';
import { calculateCumulativePaye } from './payeCumulative';
import { employerContributionWarning, employerFundBenefitWarning, isEmployerFundBenefitCode, isRetirementContributionCode } from './retirementFund';
import { calculateUIF } from './uifEngine';
import { calculateSDL } from './sdlEngine';
import { resolveEtiForEmployee } from './etiEngine';
import { remunerationBeforeDeductions } from './payrollLineRemuneration';
import type {
  PayrollLineInput,
  PayrollLineResult,
  ComponentBreakdownItem,
  EtiResult,
  ValidationResult,
} from './payrollTypes';

const round2 = (n: number): number => Math.round(n * 100) / 100;

/*
 * Non-cash fringe benefits (design, Hein 2026-11-03: settle it once, end to end).
 * Today the one non-cash earning is the low-interest loan benefit, SARS 3801, which
 * appendLoanComponents injects with `isNonCash` (a cash equivalent, Seventh Schedule
 * para 11; nothing is paid). Any earning carrying `isNonCash` is treated so:
 *  - PAYE: remuneration (Fourth Schedule para 1 (a) takes in para (i) of "gross income"),
 *    so it is periodic taxable pay like cash. loadLoanComponents takes only a taxable 3801.
 *  - UIF: the component's is_uif_applicable flag, as for every earning; setup-components
 *    creates the 3801 with it off. Whether UIF's "remuneration" takes in a benefit is not
 *    settled here (no SARS/UIF source fetched): the flag is the one switch.
 *  - SDL: leviable when is_sdl_applicable (setup default on; SDL Act s3(4) is para 1
 *    remuneration), and part of the employer's s4(b) threshold basis, `remuneration`.
 *  - ETI: in "monthly remuneration" (the para 1 remuneration), as when it was paid as cash.
 *  - Cash: NOT in grossPay, so not in netPay or the journal (DR labour = gross = cash),
 *    though the PAYE on it is withheld from the cash.
 * Stored per line: gross_pay (and the header's total_gross) = cash earnings only;
 * taxable_income / periodic_taxable include the benefit; sdl is on it; the benefit itself
 * is the breakdown item flagged `isNonCash: true`. A line costed before the flag existed
 * has the benefit inside gross_pay and no flag. Readers that need remuneration rather than
 * cash add the flagged items (findOverdrawnLines leaves them out of deductions;
 * estimateAnnualRemuneration adds them to each earlier month's total_gross).
 */
export function calculatePayrollLine(input: PayrollLineInput): PayrollLineResult {
  const { employee, components, period, taxYear, annualPayrollEstimate } = input;

  const periodDate = new Date(period.year, period.month - 1, 28);
  // SARS grants the age rebates for the whole year of assessment to an
  // employee who reaches 65 / 75 on or before its last day (end of February),
  // so the rebate age is taken there, not at the pay date.
  const taxYearEnd = new Date(taxYear, 2, 0);
  const rebateAge = employee.dateOfBirth ? getAge(employee.dateOfBirth, taxYearEnd) : 30;

  let grossPay = 0;
  // Every earning, non-cash benefits included (grossPay is cash only): PayrollLineResult.remuneration.
  let allEarnings = 0;
  // Taxable earnings by how PAYE treats them (payeTreatment): periodic pay is
  // taxed cumulatively to date (payeCumulative), annual payments (3605) by the
  // SARS annual-payment method on top of it, lump sums (39xx) carry only their
  // directive's PAYE.
  let periodicTaxable = 0;
  let annualPayments = 0;
  let taxableDeductions = 0;
  let directivePaye = 0;
  let uifLeviable = 0;
  let sdlLeviable = 0;
  let totalDeductions = 0;
  // Medical scheme fees the employee pays through payroll: deductions coded
  // 4005 (e@syFile 4005; BRS V25.3.0 p. 52-53, 101). Employer-paid medical aid
  // (the 3810 fringe benefit, deemed paid by the employee) is not supported.
  // They decide the 65+ additional medical expenses tax credit (payeEngine).
  let medicalSchemeFees = 0;
  let loanInstalments = 0;
  // Employee retirement fund contributions: deductions coded 4001/4003/4006,
  // deducted before PAYE within section 11F (payeCumulative, retirementFund).
  let retirementContributions = 0;
  // Donations (4030, s18A) deducted as taxable deductions: the s11F base is taken before them (payeCumulative).
  let donations = 0;

  const breakdown: ComponentBreakdownItem[] = [];
  const warnings: ValidationResult[] = [];

  for (const { component, amount, isNonCash, directive } of components) {
    // Only a retirement contribution can be paid outside payroll (CHECK on payroll_components, migration 948).
    const contribution = component.componentType === 'deduction' && isRetirementContributionCode(component.sarsSourceCode);
    const outsidePayroll = contribution && component.paidOutsidePayroll === true;
    breakdown.push({
      componentId: component.id,
      componentName: component.name,
      sarsSourceCode: component.sarsSourceCode,
      amount,
      // As the line was costed: a LOAN deduction is never taxable (below), whatever the catalogue says.
      isTaxable: component.isTaxable && !(component.componentType === 'deduction' && normaliseSarsCode(component.sarsSourceCode) === 'LOAN'),
      isUifApplicable: component.isUifApplicable,
      ...(isNonCash ? { isNonCash: true } : {}),
      ...(directive ? { directive } : {}),
      // Marked on the line itself, so the certificate never re-reads today's components (payrollRetirementRecord).
      ...(contribution ? { retirementContribution: true as const } : {}),
      ...(outsidePayroll ? { paidOutsidePayroll: true as const } : {}),
    });

    if (component.componentType === 'earning') {
      allEarnings += amount;
      if (!isNonCash) grossPay += amount;
      if (component.isUifApplicable) uifLeviable += amount;
      if (component.isSdlApplicable) sdlLeviable += amount;
      if (isEmployerFundBenefitCode(component.sarsSourceCode)) warnings.push(employerFundBenefitWarning(component.name, component.sarsSourceCode, amount));
      const treatment = payeTreatment(component.sarsSourceCode);
      // Any lump-sum earning, taxable flag or not: para 9(3) of the Fourth
      // Schedule requires the directive before a lump sum is paid at all.
      if (treatment === 'lump_sum' && !directive) {
        warnings.push({
          code: 'LUMP_SUM_WITHOUT_DIRECTIVE',
          severity: 'warning',
          message: `${component.name} (code ${component.sarsSourceCode}, R ${amount.toFixed(2)}) is a lump sum, which SARS taxes only at the figures on a tax directive, `
            + 'so no PAYE was deducted from it. Obtain the directive before paying it.',
        });
      }
      if (!component.isTaxable) continue;
      if (treatment === 'lump_sum') {
        if (directive) directivePaye += directive.paye;
      } else if (treatment === 'annual') {
        annualPayments += amount;
      } else {
        periodicTaxable += amount;
      }
    } else if (component.componentType === 'deduction') {
      // Paid by the employee to the fund directly: off the tax, not off the pay (nor the 2175 journal line).
      if (!outsidePayroll) totalDeductions += amount;
      // A retirement contribution by its code, whatever its taxable flag: capped below, never the uncapped path.
      if (contribution) retirementContributions += amount;
      // A loan instalment is never a tax deduction, whatever the component says (Hein: a taxable LOAN is refused).
      else if (component.isTaxable && normaliseSarsCode(component.sarsSourceCode) !== 'LOAN') {
        taxableDeductions += amount;
        if (normaliseSarsCode(component.sarsSourceCode) === '4030') donations += amount;
      }
      if (normaliseSarsCode(component.sarsSourceCode) === '4005') medicalSchemeFees += amount;
      if (normaliseSarsCode(component.sarsSourceCode) === 'LOAN') loanInstalments += amount;
    } else {
      // An employer's contribution (PAYE 4b): neither the fringe benefit nor the deemed contribution is computed.
      warnings.push(employerContributionWarning(component.name, amount));
    }
  }

  // A month counts as a periodic-remuneration period when periodic remuneration
  // was paid. Capture that before an annual-payment clawback or a taxable
  // deduction can reduce the amount taxed from the tables.
  const remuneration = remunerationBeforeDeductions(periodicTaxable, annualPayments);
  // A net negative annual payment (a bonus clawback) reduces regular pay, as it
  // did before the split. Taxable deductions come off regular pay first, any
  // excess off the annual payments, so the taxed total is unchanged by the split.
  if (annualPayments < 0) {
    periodicTaxable += annualPayments;
    annualPayments = 0;
  }
  const periodicRemuneration = remuneration.periodic;
  const annualPaymentRemuneration = remuneration.annualPayment;
  const regularTaxable = Math.max(0, periodicTaxable - taxableDeductions);
  const annualTaxable = Math.max(0, annualPayments - Math.max(0, taxableDeductions - periodicTaxable));

  const medicalBeneficiaries = employee.medicalAidMainMember
    ? 1 + employee.medicalAidDependantsCount
    : employee.medicalAidDependantsCount;

  // Fees deducted for a scheme the employee is not recorded as a member of: no MTC (and, 65+, no
  // additional credit) is given, so PAYE is over-deducted. Warned, not corrected: the membership is data.
  if (medicalSchemeFees > 0 && medicalBeneficiaries <= 0) {
    warnings.push({
      code: 'MEDICAL_FEES_WITHOUT_MEMBERSHIP',
      severity: 'warning',
      message: `R${medicalSchemeFees.toFixed(2)} of medical aid contributions (code 4005) is deducted, but the employee is not marked as a `
        + `medical aid member and has no dependants, so no medical tax credit${rebateAge >= 65 ? ' (nor the 65+ additional credit)' : ''} `
        + 'was given and PAYE is over-deducted. Set the medical aid membership on the employee and recalculate.',
    });
  }
  const { regular, annualPaymentPaye, medicalCredit, additionalMedicalCredit, retirementDeduction } = calculateCumulativePaye({
    regularTaxable,
    annualPayments: annualTaxable,
    periodicRemuneration,
    annualPaymentRemuneration,
    ytd: input.ytd ?? { periods: 0, periodicTaxable: 0, annualPayments: 0, tablePaye: 0, medicalCredit: 0, additionalMedicalCredit: 0, medicalSchemeFees: 0 },
    taxYear,
    rebateAge,
    monthlyMedicalBeneficiaries: medicalBeneficiaries,
    medicalSchemeFees,
    retirementContributions,
    donations,
  });
  // Taxable remuneration BEFORE the retirement fund deduction, which is its own figure (retirementDeduction): a
  // line's record can exceed its pay (a catch-up contribution), and taxable_income must not go negative.
  const taxableIncome = regularTaxable + annualTaxable;
  const payeSplit = { regular: regular.monthlyPaye, annualPayment: annualPaymentPaye, directive: round2(directivePaye) };
  const paye = { ...regular, monthlyPaye: round2(payeSplit.regular + payeSplit.annualPayment + payeSplit.directive) };

  const uif = employee.uifExcluded
    ? { employeeContribution: 0, employerContribution: 0, isCapped: false }
    : calculateUIF(uifLeviable, taxYear);

  // Leviability depends on the employer's twelve-month remuneration, not on
  // this line, so a caller costing a full run defers and applies the threshold
  // once it knows that total.
  const sdl = annualPayrollEstimate === 'defer'
    ? 0
    : calculateSDL(sdlLeviable, annualPayrollEstimate, taxYear);

  // Missing dates are reported as indeterminate, never fabricated into a
  // determination of "not eligible" — see resolveEtiForEmployee.
  // The ETI base stays the whole remuneration, annual payments, lump sums and
  // non-cash benefits included, unchanged by P3: "monthly remuneration" is the Fourth Schedule paragraph 1
  // remuneration ("salary, leave pay, wage, overtime pay, bonus, gratuity, ...")
  // paid or payable in the month (SARS Guide to the Employment Tax Incentive,
  // Issue 5, §2.4 "Monthly remuneration",
  // https://www.sars.gov.za/wp-content/uploads/Ops/Guides/LAPD-ETI-G01-Guide-to-the-Employment-Tax-Incentive.pdf).
  const resolved: EtiResult = resolveEtiForEmployee({
    dateOfBirth: employee.dateOfBirth,
    employmentStartDate: employee.startDate,
    periodDate,
    monthlyRemuneration: allEarnings,
    isUifExcluded: employee.uifExcluded,
  }, taxYear);
  // A leaver paid after leaving worked no hours in the period, and ETI is
  // apportioned by hours employed and paid for out of 160 (section 7(5); same
  // guide, §2.4 and §5.3 "Employee employed for part of a month"): nil.
  const etiRaw: EtiResult = input.notEmployedInPeriod
    ? {
      ...resolved, isEligible: false, isDeterminable: true, missingInputs: [], monthlyEti: 0,
      ineligibilityReason: 'Not employed in this period (paid after leaving): ETI is apportioned by hours employed, none here.',
    }
    : resolved;

  const netPay = Math.round(
    (grossPay - totalDeductions - paye.monthlyPaye - uif.employeeContribution) * 100,
  ) / 100;

  // Reported, never corrected: the line below still floors net at nil, and every other figure stands.
  // The approval gate refuses a run carrying DEDUCTIONS_EXCEED_PAY (findOverdrawnLines). A shortfall that
  // would not exist without the loan instalment is only a warning: an instalment cannot be edited on a
  // run, and refusing it would stop every employee's pay over one leaver's last month.
  if (netPay < 0) {
    const fromLoan = round2(netPay + loanInstalments) >= 0;
    // A non-cash benefit is taxed but not paid: its PAYE comes out of the cash, which may be why.
    const nonCash = round2(allEarnings - grossPay);
    const benefitNote = nonCash > 0 ? ` PAYE includes the tax on ${formatMoney(nonCash)} of non-cash benefits, which are taxed but not paid.` : '';
    warnings.push(fromLoan ? {
      code: 'LOAN_INSTALMENT_EXCEEDS_PAY',
      severity: 'warning',
      rawNet: netPay,
      message: `The loan instalment takes ${formatMoney(-netPay)} more than this employee's pay, so net pay shows as nil and `
        + `the deductions payable are understated by that amount.${benefitNote}`,
    } : {
      code: 'DEDUCTIONS_EXCEED_PAY',
      severity: 'error',
      rawNet: netPay,
      message: `Deductions and tax come to ${formatMoney(-netPay)} more than this employee's pay, so net pay shows as nil and `
        + `the deductions payable are understated by that amount.${benefitNote} Reduce the deductions, then recalculate.`,
    });
  }

  return {
    employeeId: employee.id,
    grossPay: Math.round(grossPay * 100) / 100,
    remuneration: round2(allEarnings),
    taxableIncome: Math.round(taxableIncome * 100) / 100,
    periodicTaxable: round2(regularTaxable),
    annualTaxable: round2(annualTaxable),
    periodicRemuneration: round2(periodicRemuneration),
    annualPaymentRemuneration: round2(annualPaymentRemuneration),
    paye,
    payeSplit,
    medicalCredit,
    additionalMedicalCredit,
    medicalSchemeFees: round2(medicalSchemeFees),
    retirementContributions: round2(retirementContributions),
    retirementDeduction,
    uif,
    sdl: Math.round(sdl * 100) / 100,
    sdlLeviable: Math.round(sdlLeviable * 100) / 100,
    eti: etiRaw,
    netPay: Math.max(0, netPay),
    componentBreakdown: breakdown,
    validationResults: warnings,
  };
}
