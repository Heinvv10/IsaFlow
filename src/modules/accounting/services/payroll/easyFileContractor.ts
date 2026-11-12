/**
 * An independent contractor on the e@syFile certificate (TS-b). Income "reflects under code 3616", never 3601 (the employee's
 * gross salary): PAYE-GEN-01-G21 (2027) Rev 1 p. 26 "IRP5/IT3(a) details". It is decided PER LINE, by the line's own
 * PAYE_OUTSIDE_TABLES result with treatment none (payrollOutsideTables.contractorLineFlag), never from the employee's tax status
 * today: a person switched mid-year files the months paid as an employee under 3601 and the months paid as a contractor under 3616.
 * IsaFlow takes no PAYE from a contractor (taxStatusTreatment), so a certificate with no tax is an IT3(a) with 4150 = 03, which
 * the BRS lists for exactly this case: SARS PAYE Employer Reconciliation BRS V25.3.0 p. 109, "03 or 3 = Independent contractor or
 * Directors fees for RSA resident NED", and p. 62, "Value 3 or 03 is only valid if code 3616/3666 has been completed or code
 * 3620/3670 has been completed". Whatever the amount: the threshold reasons (02, 04) and nilTaxReason, which refuses a whole file for
 * pay over the threshold with no tax, do not apply. ALL of a contractor line's income is 3616, including what the payroll component
 * calls a 3605 annual payment (a contractor has no employee annual payment), so 03 always has its 3616 beside it (coordinator
 * ruling, 2026-11-10). A certificate with PAYE withheld is an IRP5 with 3616 and no 4150.
 */
import { nilTaxReason } from './easyFileMedicalFields';
import type { EmployeeInput } from './easyFileExportService';

export interface ContractorSplitInput {
  /** SUM(gross_pay) over the employee's declarable lines of the year (contractor lines included). */
  totalGross: number;
  /** SUM(gross_pay) over those lines that are a contractor's. */
  contractorGross: number;
  /** The taxable 3605 inside those contractor lines: it is 3616, so it leaves the employee's 3605. */
  contractorAnnual: number;
  /** The directive lump sums (39xx) inside those lines: filed as lump sums, so out of 3616 (and still in the gross the lump-sum split removes). */
  contractorDirective: number;
  /** The non-cash benefits inside those lines (outside gross_pay): 3616, never filed as 38xx. */
  contractorNonCash: number;
  /** The employee's taxable 3605 over ALL the year's lines (what listRunAnnualPayments reads). */
  annualAll: number;
  /** Stand-alone directive payments, which are never a contractor's. */
  standaloneGross: number;
}

/**
 * What splitCertificateIncome takes (the employee months' gross, with the contractor months' directive lump sums and the stand-alone
 * directives added so the lump-sum split removes each once, and the employee's own annual payments) and the 3616 income.
 */
export function splitContractorIncome(i: ContractorSplitInput): { salaryGross: number; annualPayments: number; income3616: number } {
  // No floor anywhere on the contractor lines' totals: a directive reversal on a contractor line can exceed the line's fees (or be all the
  // line holds) while the year's lump-sum net is nil, so gross and directive are both taken signed. The fees are what is left of the
  // contractor gross once the directive lump sums (netted as listRunLumpSums nets them) are out; only the fees are floored, at nil.
  const fees = i.contractorGross - i.contractorDirective;
  return {
    salaryGross: i.totalGross - i.contractorGross + i.contractorDirective + i.standaloneGross,
    annualPayments: Math.max(0, i.annualAll - Math.max(0, i.contractorAnnual)),
    income3616: Math.max(0, fees) + Math.max(0, i.contractorNonCash),
  };
}

/** 4150 for a certificate with no tax that carries contractor income (BRS V25.3.0 p. 109). */
export const CONTRACTOR_NON_DEDUCTION_REASON = '03';

/**
 * The 4150 of a certificate with no tax. Contractor income present: 03, but the employee part (3601, 3605, fringe benefits) is judged
 * first by nilTaxReason, which throws for pay over the threshold with no tax and returns a reason when it is nil or passes; so 120 000 of
 * employee pay with nil PAYE beside 1 000 of contractor fees is refused, not hidden behind 03.
 */
export function contractorAwareReason(emp: EmployeeInput): string {
  if ((emp.independentContractor3616 ?? 0) <= 0) return nilTaxReason(emp);
  const employeeIncome = Math.max(0, emp.grossSalary3601) + Math.max(0, emp.annualPayments3605 ?? 0)
    + (emp.fringeBenefits ?? []).reduce((t, f) => t + Math.max(0, f.amount), 0)
    + (emp.cashAllowances ?? []).reduce((t, f) => t + Math.max(0, f.amount), 0);
  if (employeeIncome > 0) nilTaxReason(emp);
  return CONTRACTOR_NON_DEDUCTION_REASON;
}
