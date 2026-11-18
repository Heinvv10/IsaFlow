/**
 * The shapes `irp5DataService.getIrp5EmployeeTotals` returns (split out of irp5DataService.ts, wave 6 EF, to keep
 * that file under 300 lines). Re-exported from irp5DataService.
 */
import type { LumpSumFiling } from './payrollLumpSumFiling';
import type { NonCashBenefitFiling } from './payrollNonCashFiling';

export interface Irp5EmployeeTotals {
  employeeId: string;
  employeeNumber: string;
  firstName: string;
  lastName: string;
  /** Masked to the last four digits unless the caller asked to reveal them. */
  idNumber: string | null;
  taxNumber: string | null;
  identityNumbersMasked: boolean;
  /** Cash only: a non-cash benefit is not in it (fringeBenefits). */
  grossSalary: number;
  taxableIncome: number;
  paye: number;
  uifEmployee: number;
  uifEmployer: number;
  sdl: number;
  eti: number;
  netPay: number;
  runsIncluded: number;
  /**
   * Lump sums paid under a SARS directive, in a run (3901 severance, audit
   * 2026-10-18 P3) or outside payroll (PAYE 4a follow-ups G1). Already inside
   * grossSalary and paye; the certificate shows them under their own code, the
   * PAYE under `payeCode`.
   */
  lumpSums: LumpSumFiling[];
  /**
   * Non-cash fringe benefits (the 3801 loan benefit), NOT in grossSalary; in taxableIncome and
   * paye. The certificate shows them under their own code (payrollNonCashFiling), so
   * grossSalary + these is the remuneration.
   */
  fringeBenefits: NonCashBenefitFiling[];
  /** Cash allowances the certificate shows under their own code (3701; reimbursive travel 3702 / 3703 / 3722; whole rand), INSIDE grossSalary (payrollAllowanceFiling). */
  cashAllowances: NonCashBenefitFiling[];
  /** 4582: the part of 3701 + 3802 PAYE was withheld on (BRS V25.3.0 p. 105); null when the employee has neither. */
  paye4582: number | null;
}

export interface Irp5Exclusion {
  id: string;
  reason: string;
  detail?: string;
  amount?: number;
}

export interface Irp5Dataset {
  taxYear: number;
  periodStart: string;
  periodEnd: string;
  rows: Irp5EmployeeTotals[];
  rowsTotal: number;
  universeTotal: number;
  /** Employees excluded IN TOTAL; `excluded` may carry only a capped sample. */
  excludedTotal: number;
  excluded: Irp5Exclusion[];
  postedThrough: string | null;
  /** Each employee whose 3801 items were paid in cash (no flag), so are in grossSalary / 3601. */
  warnings: string[];
}
