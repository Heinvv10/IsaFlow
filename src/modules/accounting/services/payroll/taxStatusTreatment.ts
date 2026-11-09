/**
 * How a tax status and an employment class change the deductions on a line. Pure.
 *
 * - independent_contractor: income "specifically excluded from the definition of remuneration" (G21 (2027) Rev 1 p. 26,
 *   "Independent contractor", Fourth Schedule para 1): no PAYE, UIF, SDL or ETI. The employer has applied SARS's tests
 *   (p. 26 "Exceptions", Interpretation Note 17); the line's warning says so (outsideTablesResult).
 * - employee in non-standard employment: 25% of the balance of remuneration (G21 p. 28 "Employees' tax"). No rebates or
 *   credits come off a flat rate: the guide gives none.
 * - director: on the tables like any employee. G21 p. 27 gives a director no monthly rule of its own; its only director-specific
 *   items are s7B deemed remuneration (variable pay accrues when paid, from 1 March 2017) and the right of recovery, neither a
 *   PAYE figure here. Fourth Schedule para 11C was deleted from 1 March 2013 (LOW confidence: the guide does not mention it).
 *   Sage's director ("phekis" in the oracle) is on the statutory tables and pays UIF, as here.
 * UIF, SDL and ETI stay on for every employee: only a contractor is outside them.
 */
import type { PayrollEmployee, ValidationResult } from './payrollTypes';
import type { EmploymentClass } from './employmentTerms';

export type PayeTreatment = 'tables' | 'flat_25' | 'none';
export interface TaxStatusTreatment { paye: PayeTreatment; uif: boolean; sdl: boolean; eti: boolean }

/** The flat rate on the balance of remuneration (G21 p. 28). */
export const NON_STANDARD_RATE = 0.25;

/** On a line whose PAYE did not come from the tables: the year to date leaves it out (payrollYearToDate), so no table month re-trues it. */
export const PAYE_OUTSIDE_TABLES = 'PAYE_OUTSIDE_TABLES';

export function taxStatusTreatment(status: PayrollEmployee['taxStatus'], kind: EmploymentClass): TaxStatusTreatment {
  if (status === 'independent_contractor') return { paye: 'none', uif: false, sdl: false, eti: false };
  return { paye: status === 'employee' && kind === 'non_standard_flat' ? 'flat_25' : 'tables', uif: true, sdl: true, eti: true };
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** This line's PAYE under the treatment, from what the tables gave. `taxable` is the balance of remuneration (after allowed deductions). */
export function payeUnderTreatment(
  treatment: PayeTreatment, tables: { regular: number; annualPayment: number }, taxable: number,
): { regular: number; annualPayment: number } {
  if (treatment === 'none') return { regular: 0, annualPayment: 0 };
  if (treatment === 'flat_25') return { regular: round2(NON_STANDARD_RATE * Math.max(0, taxable)), annualPayment: 0 };
  return tables;
}

/** The result stored on a line whose PAYE was not taken from the tables (its code is what the year to date reads). */
export function outsideTablesResult(treatment: 'flat_25' | 'none'): ValidationResult[] {
  if (treatment === 'none') {
    return [{
      code: PAYE_OUTSIDE_TABLES, severity: 'warning', treatment,
      message: 'Independent contractor: no PAYE, UIF, SDL or ETI was taken. The employer has applied the independent-contractor tests '
        + '(PAYE-GEN-01-G21 p. 26, Interpretation Note 17); a contractor who fails them is an employee.',
    }];
  }
  return [{
    code: PAYE_OUTSIDE_TABLES, severity: 'warning', treatment,
    message: 'Non-standard employment (PAYE-GEN-01-G21 p. 28): PAYE is 25% of the balance of remuneration, not the tables. '
      + 'An employee who works under 22 hours a week and furnished a written declaration that he or she serves no other employer is '
      + 'deemed standard and belongs on the tables; IsaFlow does not record that declaration, so check it before approving.',
  }];
}
