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
export interface ContractorSplitInput {
  /** SUM(gross_pay) over the employee's declarable lines of the year (contractor lines included). */
  totalGross: number;
  /** SUM(gross_pay) over those lines that are a contractor's. */
  contractorGross: number;
  /** The taxable 3605 inside those contractor lines: it is 3616, so it leaves the employee's 3605. */
  contractorAnnual: number;
  /** The employee's taxable 3605 over ALL the year's lines (what listRunAnnualPayments reads). */
  annualAll: number;
  /** Stand-alone directive payments, which are never a contractor's. */
  standaloneGross: number;
}

/** What splitCertificateIncome takes (the employee months' gross, directives added, and the employee's own annual payments) and the 3616 income. */
export function splitContractorIncome(i: ContractorSplitInput): { salaryGross: number; annualPayments: number; income3616: number } {
  const contractor = Math.min(Math.max(0, i.contractorGross), i.totalGross);
  return {
    salaryGross: i.totalGross - contractor + i.standaloneGross,
    annualPayments: Math.max(0, i.annualAll - Math.min(Math.max(0, i.contractorAnnual), contractor)),
    income3616: contractor,
  };
}

/** 4150 for a certificate with no tax that carries contractor income (BRS V25.3.0 p. 109). */
export const CONTRACTOR_NON_DEDUCTION_REASON = '03';
