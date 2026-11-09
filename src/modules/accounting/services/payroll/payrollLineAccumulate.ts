import { normaliseSarsCode, payeTreatment } from './payeAnnualPayment';
import { notPayeDeductibleWarning } from './payrollLinePaye';
import { employerContributionWarning, employerFundBenefitWarning, isEmployerFundBenefitCode, isRetirementContributionCode } from './retirementFund';
import type { ComponentBreakdownItem, EmployeeComponent, ValidationResult } from './payrollTypes';

/** The running totals of a line's components, by how PAYE, UIF and SDL treat each (moved out of payrollCalculator.ts, unchanged). */
export interface ComponentAccumulation {
  grossPay: number;
  allEarnings: number;
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

  for (const { component, amount, isNonCash, directive, quantity, quantityUnit } of components) {
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
    grossPay, allEarnings, periodicTaxable, annualPayments, directivePaye, uifLeviable, sdlLeviable,
    totalDeductions, medicalSchemeFees, loanInstalments, retirementContributions, donations, breakdown, warnings,
  };
}
