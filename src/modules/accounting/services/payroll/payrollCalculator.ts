import { getAge } from './payeEngine';
import { normaliseSarsCode, payeTreatment } from './payeAnnualPayment';
import { calculateCumulativePaye } from './payeCumulative';
import { calculateUIF } from './uifEngine';
import { calculateSDL } from './sdlEngine';
import { resolveEtiForEmployee } from './etiEngine';
import { cappedRetirementDeduction } from './retirementDeductionCap';
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
  // Taxable retirement-fund contributions (SARS codes 4001 pension, 4003
  // provident, 4006 RA) tracked separately so the s11F cap can be applied for
  // SDL. These are the only deductions that reduce the SDL base, along with
  // s18A donations (4030) capped at 5% after the retirement deduction.
  let taxableRetirementDeductions = 0;
  // s18A donations (SARS code 4030): tracked separately; capped at 5% of
  // (remuneration − capped retirement) for SDL (para 2(4)(f) Fourth Schedule).
  // Receipt (s18A certificate) not tracked in payroll — limitation.
  let taxableDonationDeductions = 0;
  let directivePaye = 0;
  let uifLeviable = 0;
  let sdlLeviable = 0;
  let totalDeductions = 0;
  // Medical scheme fees the employee pays through payroll: deductions coded
  // 4005 (e@syFile 4005; BRS V25.3.0 p. 52-53, 101). Employer-paid medical aid
  // (the 3810 fringe benefit, deemed paid by the employee) is not supported.
  // They decide the 65+ additional medical expenses tax credit (payeEngine).
  let medicalSchemeFees = 0;

  const breakdown: ComponentBreakdownItem[] = [];
  const warnings: ValidationResult[] = [];

  for (const { component, amount, directive } of components) {
    breakdown.push({
      componentId: component.id,
      componentName: component.name,
      sarsSourceCode: component.sarsSourceCode,
      amount,
      isTaxable: component.isTaxable,
      isUifApplicable: component.isUifApplicable,
      ...(directive ? { directive } : {}),
    });

    if (component.componentType === 'earning') {
      grossPay += amount;
      if (component.isUifApplicable) uifLeviable += amount;
      if (component.isSdlApplicable) sdlLeviable += amount;
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
      totalDeductions += amount;
      if (component.isTaxable) {
        taxableDeductions += amount;
        const sarsCode = normaliseSarsCode(component.sarsSourceCode);
        if (sarsCode === '4001' || sarsCode === '4003' || sarsCode === '4006') {
          taxableRetirementDeductions += amount;
        }
        if (sarsCode === '4030') {
          taxableDonationDeductions += amount;
        }
      }
      if (normaliseSarsCode(component.sarsSourceCode) === '4005') medicalSchemeFees += amount;
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
  const taxableIncome = regularTaxable + annualTaxable;
  // SDL is levied on the "balance of remuneration" after para 2(4) deductions
  // (SDL Act s3(4); SARS SDL-GEN-01-G01 Rev 5 s6; PAYE-GEN-01-G21 (2027)
  // "SDL liable amount"). SDL uses an EXPLICIT ALLOWLIST — only two categories
  // of deduction reduce the SDL base:
  //   1. Retirement-fund contributions (4001/4003/4006), capped by s11F:
  //      min(27.5% × remuneration, annualCap / 12). Source: PAYE-GEN-01-G21
  //      (2027) Rev 1 s7.3.1; PAYE-GEN-01-G20 (2026) s7.3.1.
  //   2. s18A donations (4030), capped at 5% of remuneration AFTER the capped
  //      retirement deduction. Source: PAYE-GEN-01-G21 (2027) Rev 1 'Donations'
  //      para 2(4)(f); s18A(2)(a). Limitation: receipt (s18A certificate) not
  //      tracked in payroll — this cap is computed but not receipt-verified.
  // All other taxable deductions (union fees, medical 4005, garnishees, loans,
  // etc.) do NOT reduce SDL even if isTaxable is true.
  //
  // PAYE continues using the uncapped full taxableDeductions (all codes) until
  // PR #891. SDL and PAYE bases therefore diverge for:
  //   - Retirement contributions above the s11F cap.
  //   - Non-allowlisted taxable deductions (e.g. union fees): reduce PAYE only.
  //   - Donations above the 5% cap: full amount reduces PAYE, capped for SDL.
  //
  // Unsupported for both PAYE and SDL: employer retirement contributions as
  // deemed employee contributions.
  const fourthScheduleRemuneration = periodicTaxable + annualPayments;
  const sdlRetirementAllowable = cappedRetirementDeduction(
    taxableRetirementDeductions,
    fourthScheduleRemuneration,
    12,
    taxYear,
  );
  const sdlDonationBase = Math.max(0, fourthScheduleRemuneration - sdlRetirementAllowable);
  const sdlDonationAllowable = Math.min(taxableDonationDeductions, sdlDonationBase * 0.05);
  const para24DeductionsForSdl = Math.max(
    0,
    Math.min(sdlRetirementAllowable + sdlDonationAllowable, fourthScheduleRemuneration),
  );

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
  const { regular, annualPaymentPaye, medicalCredit, additionalMedicalCredit } = calculateCumulativePaye({
    regularTaxable,
    annualPayments: annualTaxable,
    ytd: input.ytd ?? { periods: 0, periodicTaxable: 0, annualPayments: 0, tablePaye: 0, medicalCredit: 0, additionalMedicalCredit: 0, medicalSchemeFees: 0 },
    taxYear,
    rebateAge,
    monthlyMedicalBeneficiaries: medicalBeneficiaries,
    medicalSchemeFees,
  });
  const payeSplit = { regular: regular.monthlyPaye, annualPayment: annualPaymentPaye, directive: round2(directivePaye) };
  const paye = { ...regular, monthlyPaye: round2(payeSplit.regular + payeSplit.annualPayment + payeSplit.directive) };

  const uif = employee.uifExcluded
    ? { employeeContribution: 0, employerContribution: 0, isCapped: false }
    : calculateUIF(uifLeviable, taxYear);

  // SDL exclusions (components not SDL-applicable) are already out of
  // sdlLeviable; the s11F-capped para 2(4) deductions come off what remains, never below nil.
  const sdlLeviableAfterDeductions = Math.max(0, sdlLeviable - para24DeductionsForSdl);

  // Leviability depends on the employer's twelve-month remuneration, not on
  // this line, so a caller costing a full run defers and applies the threshold
  // once it knows that total.
  const sdl = annualPayrollEstimate === 'defer'
    ? 0
    : calculateSDL(sdlLeviableAfterDeductions, annualPayrollEstimate, taxYear);

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
    uif,
    sdl: Math.round(sdl * 100) / 100,
    sdlLeviable: round2(sdlLeviableAfterDeductions),
    eti: etiRaw,
    netPay: Math.max(0, netPay),
    componentBreakdown: breakdown,
    validationResults: warnings,
  };
}
