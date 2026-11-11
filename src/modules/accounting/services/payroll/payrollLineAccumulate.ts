import { formatMoney } from '@/lib/money/formatMoney';
import { normaliseSarsCode, payeTreatment } from './payeAnnualPayment';
import { deemedMedicalFees, deemedRetirementContributions, isEmployerMedicalFringeCode } from './employerContributions';
import { effectiveInclusionRate, includedInPaye, VEHICLE_CODE } from './fringeBenefits';
import { notPayeDeductibleWarning } from './payrollLinePaye';
import { employerContributionWarning, employerFundBenefitWarning, isEmployerFundBenefitCode, isRetirementContributionCode, retirementBenefitNotTaxableWarning } from './retirementFund';
import type { ComponentBreakdownItem, EmployeeComponent, ValidationResult } from './payrollTypes';

/** The running totals of a line's components, by how PAYE, UIF and SDL treat each (moved out of payrollCalculator.ts, unchanged). */
export interface ComponentAccumulation {
  grossPay: number;
  allEarnings: number;
  /** Earnings as the Fourth Schedule para 1 "remuneration": a 3701 / 3802 at its PAYE share. What SDL and ETI read. */
  levyRemuneration: number;
  /** The employer's 3810 medical contribution deemed paid by the employee (inside medicalSchemeFees). */
  employerMedicalFees: number;
  periodicTaxable: number;
  annualPayments: number;
  directivePaye: number;
  uifLeviable: number;
  sdlLeviable: number;
  totalDeductions: number;
  medicalSchemeFees: number;
  loanInstalments: number;
  retirementContributions: number;
  donations: number;
  breakdown: ComponentBreakdownItem[];
  warnings: ValidationResult[];
}

export function accumulateComponents(components: EmployeeComponent[]): ComponentAccumulation {
  let grossPay = 0;
  // Every earning, non-cash benefits included (grossPay is cash only): PayrollLineResult.remuneration.
  let allEarnings = 0;
  let levyRemuneration = 0;
  // Taxable earnings by how PAYE treats them (payeTreatment): periodic pay is
  // taxed cumulatively to date (payeCumulative), annual payments (3605) by the
  // SARS annual-payment method on top of it, lump sums (39xx) carry only their
  // directive's PAYE.
  let periodicTaxable = 0;
  let annualPayments = 0;
  let directivePaye = 0;
  let uifLeviable = 0;
  let sdlLeviable = 0;
  let totalDeductions = 0;
  // Medical scheme fees the employee pays through payroll: deductions coded
  // 4005 (e@syFile 4005; BRS V25.3.0 p. 52-53, 101), plus the employer's contribution (the 3810 fringe
  // benefit), which is deemed paid by the employee (G21 p. 12, employerContributions.ts). They decide the 65+ additional medical expenses tax credit (payeEngine).
  let medicalSchemeFees = 0;
  let loanInstalments = 0;
  // Retirement fund contributions: deductions coded 4001/4003/4006, plus the employer's non-cash 3817/3825/3828 benefit
  // deemed paid by the employee (G21 (2027) p. 10; employerContributions.ts), deducted before PAYE within section 11F
  // on their total (payeCumulative, retirementFund).
  let retirementContributions = deemedRetirementContributions(components);
  // Donations (4030, s18A) deducted as taxable deductions: the s11F base is taken before them (payeCumulative).
  let donations = 0;

  const breakdown: ComponentBreakdownItem[] = [];
  const warnings: ValidationResult[] = [];
  const employerMedicalFees = deemedMedicalFees(components);
  const employeeMedical4005 = components.filter((c) => c.component.componentType === 'deduction' && normaliseSarsCode(c.component.sarsSourceCode) === '4005').reduce((n, c) => n + c.amount, 0);
  medicalSchemeFees += employerMedicalFees;

  for (const { component, amount, isNonCash, directive, quantity, quantityUnit, medicalGrossUp, payeInclusionRate: given, percentOfRfi, rfiBase } of components) {
    // 3701 is 80% remuneration unless a record says business use is at least 80%; one default (fringeBenefits.ts, G21 p. 5).
    const payeInclusionRate = component.componentType === 'earning' && component.isTaxable ? effectiveInclusionRate(component.sarsSourceCode, given) : undefined;
    const included = payeInclusionRate === undefined ? amount : includedInPaye(amount, payeInclusionRate);
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
      // Counted toward the SDL-applicable remuneration below: the year to date rebuilds it from this (payrollSdlYearToDate).
      isSdlApplicable: component.componentType === 'earning' && component.isSdlApplicable,
      ...(quantity != null && quantityUnit != null ? { quantity, quantityUnit, ...(quantity > 0 ? { rate: Math.round((amount / quantity) * 10000) / 10000 } : {}) } : {}),
      ...(isNonCash ? { isNonCash: true } : {}),
      ...(payeInclusionRate !== undefined ? { payeInclusionRate, ...(component.isTaxable ? { payeIncludedAmount: included } : {}) } : {}),
      ...(directive ? { directive } : {}),
      // Marked on the line itself, so the certificate never re-reads today's components (payrollRetirementRecord).
      ...(contribution ? { retirementContribution: true as const } : {}),
      ...(outsidePayroll ? { paidOutsidePayroll: true as const } : {}),
      ...(percentOfRfi != null && rfiBase !== undefined ? { percentOfRfi, rfiBase } : {}),
    });

    if (component.componentType === 'earning') {
      allEarnings += amount;
      levyRemuneration += included;
      if (!isNonCash) grossPay += amount;
      // SDL (SDL Act s3) and UIF (UIF Contributions Act s1: remuneration as the Fourth Schedule para 1 defines it) are
      // levied on "remuneration", which takes in a taxable 3701 / 3802 at its PAYE share. A non-taxable earning has no share.
      if (component.isUifApplicable) uifLeviable += included;
      if (component.isSdlApplicable) sdlLeviable += included;
      if (normaliseSarsCode(component.sarsSourceCode) === VEHICLE_CODE && !isNonCash) {
        warnings.push({ code: 'FRINGE_RECORD_MISSING', severity: 'warning',
          message: `${component.name} (code 3802, ${formatMoney(amount)}) is a hand-assigned vehicle earning: it is paid as cash and taxed in full (100%). `
            + 'Record the vehicle on the employee profile (determined value, maintenance plan, business use) and remove this assignment, so it is a non-cash benefit taxed at 80% or 20%.' });
      }
      // The employer's medical contribution (3810) is deemed paid by the employee for the credits (G21 p. 12), counted
      // once above (deemedMedicalFees); here only what the line must say about it.
      if (isEmployerMedicalFringeCode(component.sarsSourceCode)) {
        if (!component.isTaxable) {
          warnings.push({ code: 'MEDICAL_BENEFIT_NOT_TAXABLE', severity: 'error',
            message: `${component.name} (code 3810, ${formatMoney(amount)}) is an employer medical contribution, a taxable fringe benefit (Seventh Schedule para 12A), but the component is not taxable: `
              + 'no PAYE and no deemed medical fees were taken from it. Mark the component taxable and recalculate.' });
        } else if (medicalGrossUp && employeeMedical4005 <= 0) {
          warnings.push({ code: 'MEDICAL_GROSS_UP_WITHOUT_4005', severity: 'warning',
            message: `${component.name} (code 3810, ${formatMoney(amount)}) is under the medical gross-up recorded for this employee, but there is no 4005 deduction `
              + 'taking the premium back: a gross-up needs the 4005 premium deduction. Add the deduction, or end the gross-up record so the 3810 is the employer\'s share.' });
        } else if (medicalGrossUp) {
          warnings.push({ code: 'MEDICAL_GROSS_UP_PATTERN', severity: 'info',
            message: `${component.name} (code 3810) is treated as cash under the medical gross-up recorded for this employee: it is taxed as cash and `
              + 'its fees are the 4005 deduction alone, not counted a second time.' });
        } else if (employeeMedical4005 >= amount) {
          warnings.push({ code: 'MEDICAL_SPLIT_ASSUMED', severity: 'info',
            message: `${component.name} (code 3810, ${formatMoney(amount)}) is treated as the employer's share of the medical contribution (a non-cash benefit deemed paid by the employee) `
              + `and the 4005 deduction as the employee's own share. If the 3810 is paid in cash and the whole premium deducted as 4005, record "Medical gross-up" on the employee profile.` });
        }
      }
      // An employer's fund contribution (3817 / 3825 / 3828): deemed above when taxable and non-cash, as a run marks it (RF).
      if (isEmployerFundBenefitCode(component.sarsSourceCode)) {
        if (!component.isTaxable) warnings.push(retirementBenefitNotTaxableWarning(component.name, component.sarsSourceCode, amount));
        else if (!isNonCash) warnings.push(employerFundBenefitWarning(component.name, component.sarsSourceCode, amount));
      }
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
        // A travel allowance (3701) and a company vehicle (3802) are remuneration only in part: 80%, or 20% where
        // the employer is satisfied at least 80% of the use is business (fringeBenefits.ts, G21 p. 5).
        periodicTaxable += payeInclusionRate === undefined ? amount : includedInPaye(amount, payeInclusionRate);
      }
    } else if (component.componentType === 'deduction') {
      // Paid by the employee to the fund directly: off the tax, not off the pay (nor the 2175 journal line).
      if (!outsidePayroll) totalDeductions += amount;
      // A retirement contribution by its code, whatever its taxable flag: capped by s11F below.
      if (contribution) retirementContributions += amount;
      // A loan instalment is never a tax deduction, whatever the component says (Hein: a taxable LOAN is refused).
      else if (component.isTaxable && normaliseSarsCode(component.sarsSourceCode) !== 'LOAN') {
        // A donation reduces the taxable figure only as s18aDonation allows, below.
        if (normaliseSarsCode(component.sarsSourceCode) === '4030') donations += amount;
        // Para 2(4) lets an employer deduct only retirement contributions (s11F) and s18A donations before PAYE
        // (PAYE-GEN-01-G21 (2027) Rev 1): any other deduction is paid from taxed pay, whatever its taxable flag.
        else if (amount !== 0) warnings.push(notPayeDeductibleWarning(component.name, component.sarsSourceCode, amount));
      }
      if (normaliseSarsCode(component.sarsSourceCode) === '4005') medicalSchemeFees += amount;
      if (normaliseSarsCode(component.sarsSourceCode) === 'LOAN') loanInstalments += amount;
    } else {
      // An employer's contribution (PAYE 4b): neither the fringe benefit nor the deemed contribution is computed.
      warnings.push(employerContributionWarning(component.name, amount));
    }
  }

  return {
    grossPay, allEarnings, levyRemuneration, employerMedicalFees, periodicTaxable, annualPayments, directivePaye, uifLeviable, sdlLeviable,
    totalDeductions, medicalSchemeFees, loanInstalments, retirementContributions, donations, breakdown, warnings,
  };
}
