import { getAge } from './payeEngine';
import { calculateAnnualPaymentPaye, payeTreatment } from './payeAnnualPayment';
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
  // annualised ×12, annual payments (3605) are taxed by the SARS annual-payment
  // method, lump sums (39xx) carry only their directive's PAYE.
  let periodicTaxable = 0;
  let annualPayments = 0;
  let taxableDeductions = 0;
  let directivePaye = 0;
  let uifLeviable = 0;
  let sdlLeviable = 0;
  let totalDeductions = 0;

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
      if (!component.isTaxable) continue;
      const treatment = payeTreatment(component.sarsSourceCode);
      if (treatment === 'lump_sum') {
        if (directive) {
          directivePaye += directive.paye;
        } else {
          warnings.push({
            code: 'LUMP_SUM_WITHOUT_DIRECTIVE',
            severity: 'warning',
            message: `${component.name} (code ${component.sarsSourceCode}, R ${amount.toFixed(2)}) is a lump sum, which SARS taxes only at the figures on a tax directive, `
              + 'so no PAYE was deducted from it. Obtain the directive before paying it.',
          });
        }
      } else if (treatment === 'annual') {
        annualPayments += amount;
      } else {
        periodicTaxable += amount;
      }
    } else if (component.componentType === 'deduction') {
      totalDeductions += amount;
      if (component.isTaxable) taxableDeductions += amount;
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

  const medicalBeneficiaries = employee.medicalAidMainMember
    ? 1 + employee.medicalAidDependantsCount
    : employee.medicalAidDependantsCount;

  const { regular, annualPaymentPaye } = calculateAnnualPaymentPaye({
    regularMonthlyTaxable: regularTaxable,
    annualPayments: annualTaxable,
    taxYear,
    rebateAge,
    monthlyMedicalBeneficiaries: medicalBeneficiaries,
  });
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
    paye,
    payeSplit,
    uif,
    sdl: Math.round(sdl * 100) / 100,
    sdlLeviable: Math.round(sdlLeviable * 100) / 100,
    eti: etiRaw,
    netPay: Math.max(0, netPay),
    componentBreakdown: breakdown,
    validationResults: warnings,
  };
}
