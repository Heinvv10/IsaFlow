import { getAge } from './payeEngine';
import { normaliseSarsCode, payeTreatment } from './payeAnnualPayment';
import { calculateCumulativePaye } from './payeCumulative';
import { employerContributionWarning, employerFundBenefitWarning, isEmployerFundBenefitCode, isRetirementContributionCode } from './retirementFund';
import { calculateUIF } from './uifEngine';
import { calculateSDL } from './sdlEngine';
import { resolveEtiForEmployee } from './etiEngine';
import type {
  PayrollLineInput,
  PayrollLineResult,
  ComponentBreakdownItem,
  EtiResult,
  ValidationResult,
} from './payrollTypes';

const round2 = (n: number): number => Math.round(n * 100) / 100;

export function calculatePayrollLine(input: PayrollLineInput): PayrollLineResult {
  const { employee, components, period, taxYear, annualPayrollEstimate } = input;

  const periodDate = new Date(period.year, period.month - 1, 28);
  // SARS grants the age rebates for the whole year of assessment to an
  // employee who reaches 65 / 75 on or before its last day (end of February),
  // so the rebate age is taken there, not at the pay date.
  const taxYearEnd = new Date(taxYear, 2, 0);
  const rebateAge = employee.dateOfBirth ? getAge(employee.dateOfBirth, taxYearEnd) : 30;

  let grossPay = 0;
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
  // Employee retirement fund contributions: deductions coded 4001/4003/4006,
  // deducted before PAYE within section 11F (payeCumulative, retirementFund).
  let retirementContributions = 0;

  const breakdown: ComponentBreakdownItem[] = [];
  const warnings: ValidationResult[] = [];

  for (const { component, amount, directive } of components) {
    // Only a retirement contribution can be paid outside payroll (CHECK on payroll_components, migration 948).
    const outsidePayroll = component.componentType === 'deduction' && component.paidOutsidePayroll === true
      && isRetirementContributionCode(component.sarsSourceCode);
    breakdown.push({
      componentId: component.id,
      componentName: component.name,
      sarsSourceCode: component.sarsSourceCode,
      amount,
      isTaxable: component.isTaxable,
      isUifApplicable: component.isUifApplicable,
      ...(directive ? { directive } : {}),
      ...(outsidePayroll ? { paidOutsidePayroll: true as const } : {}),
    });

    if (component.componentType === 'earning') {
      grossPay += amount;
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
      if (isRetirementContributionCode(component.sarsSourceCode)) retirementContributions += amount;
      else if (component.isTaxable) taxableDeductions += amount;
      if (normaliseSarsCode(component.sarsSourceCode) === '4005') medicalSchemeFees += amount;
    } else {
      // An employer's contribution (PAYE 4b): neither the fringe benefit nor the deemed contribution is computed.
      warnings.push(employerContributionWarning(component.name, amount));
    }
  }

  // A net negative annual payment (a bonus clawback) reduces regular pay, as it
  // did before the split. Taxable deductions come off regular pay first, any
  // excess off the annual payments, so the taxed total is unchanged by the split.
  if (annualPayments < 0) {
    periodicTaxable += annualPayments;
    annualPayments = 0;
  }
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
    ytd: input.ytd ?? { periods: 0, periodicTaxable: 0, annualPayments: 0, tablePaye: 0, medicalCredit: 0, additionalMedicalCredit: 0, medicalSchemeFees: 0 },
    taxYear,
    rebateAge,
    monthlyMedicalBeneficiaries: medicalBeneficiaries,
    medicalSchemeFees,
    retirementContributions,
  });
  // What the tables were applied to this period: remuneration less this line's retirement fund deduction.
  const taxableIncome = regularTaxable + annualTaxable - retirementDeduction;
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
  // The ETI base stays the whole gross, annual payments and lump sums included,
  // unchanged by P3: "monthly remuneration" is the Fourth Schedule paragraph 1
  // remuneration ("salary, leave pay, wage, overtime pay, bonus, gratuity, ...")
  // paid or payable in the month (SARS Guide to the Employment Tax Incentive,
  // Issue 5, §2.4 "Monthly remuneration",
  // https://www.sars.gov.za/wp-content/uploads/Ops/Guides/LAPD-ETI-G01-Guide-to-the-Employment-Tax-Incentive.pdf).
  const resolved: EtiResult = resolveEtiForEmployee({
    dateOfBirth: employee.dateOfBirth,
    employmentStartDate: employee.startDate,
    periodDate,
    monthlyRemuneration: grossPay,
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

  return {
    employeeId: employee.id,
    grossPay: Math.round(grossPay * 100) / 100,
    taxableIncome: Math.round(taxableIncome * 100) / 100,
    periodicTaxable: round2(regularTaxable),
    annualTaxable: round2(annualTaxable),
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
