import { calculatePAYE, getAge } from './payeEngine';
import { calculateUIF } from './uifEngine';
import { calculateSDL } from './sdlEngine';
import { resolveEtiForEmployee } from './etiEngine';
import type {
  PayrollLineInput,
  PayrollLineResult,
  ComponentBreakdownItem,
  EtiResult,
} from './payrollTypes';

export function calculatePayrollLine(input: PayrollLineInput): PayrollLineResult {
  const { employee, components, period, taxYear, annualPayrollEstimate } = input;

  const periodDate = new Date(period.year, period.month - 1, 28);
  const age = employee.dateOfBirth ? getAge(employee.dateOfBirth, periodDate) : 30;

  let grossPay = 0;
  let taxableIncome = 0;
  let uifLeviable = 0;
  let sdlLeviable = 0;
  let totalDeductions = 0;

  const breakdown: ComponentBreakdownItem[] = [];

  for (const { component, amount } of components) {
    breakdown.push({
      componentId: component.id,
      componentName: component.name,
      sarsSourceCode: component.sarsSourceCode,
      amount,
      isTaxable: component.isTaxable,
      isUifApplicable: component.isUifApplicable,
    });

    if (component.componentType === 'earning') {
      grossPay += amount;
      if (component.isTaxable) taxableIncome += amount;
      if (component.isUifApplicable) uifLeviable += amount;
      if (component.isSdlApplicable) sdlLeviable += amount;
    } else if (component.componentType === 'deduction') {
      totalDeductions += amount;
      if (component.isTaxable) taxableIncome -= amount;
    }
  }

  taxableIncome = Math.max(0, taxableIncome);

  const medicalBeneficiaries = employee.medicalAidMainMember
    ? 1 + employee.medicalAidDependantsCount
    : employee.medicalAidDependantsCount;

  const paye = calculatePAYE({
    annualTaxableIncome: taxableIncome * 12,
    ageAtPeriodEnd: age,
    monthlyMedicalBeneficiaries: medicalBeneficiaries,
    taxYear,
  });

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
  const etiRaw: EtiResult = resolveEtiForEmployee({
    dateOfBirth: employee.dateOfBirth,
    employmentStartDate: employee.startDate,
    periodDate,
    monthlyRemuneration: grossPay,
    isUifExcluded: employee.uifExcluded,
  }, taxYear);

  const netPay = Math.round(
    (grossPay - totalDeductions - paye.monthlyPaye - uif.employeeContribution) * 100,
  ) / 100;

  return {
    employeeId: employee.id,
    grossPay: Math.round(grossPay * 100) / 100,
    taxableIncome: Math.round(taxableIncome * 100) / 100,
    paye,
    uif,
    sdl: Math.round(sdl * 100) / 100,
    sdlLeviable: Math.round(sdlLeviable * 100) / 100,
    eti: etiRaw,
    netPay: Math.max(0, netPay),
    componentBreakdown: breakdown,
    validationResults: [],
  };
}
