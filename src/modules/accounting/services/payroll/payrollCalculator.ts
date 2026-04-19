import { calculatePAYE, getAge } from './payeEngine';
import { calculateUIF } from './uifEngine';
import { calculateSDL } from './sdlEngine';
import { calculateEti } from './etiEngine';
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

  const sdl = calculateSDL(sdlLeviable, annualPayrollEstimate, taxYear);

  const etiRaw: EtiResult = employee.dateOfBirth && employee.startDate
    ? calculateEti({
        dateOfBirth: employee.dateOfBirth,
        employmentStartDate: employee.startDate,
        periodDate,
        monthlyRemuneration: grossPay,
        isUifExcluded: employee.uifExcluded,
      }, taxYear)
    : { isEligible: false, monthsEmployed: 0, employmentYear: null, monthlyEti: 0 };

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
    eti: etiRaw,
    netPay: Math.max(0, netPay),
    componentBreakdown: breakdown,
    validationResults: [],
  };
}
