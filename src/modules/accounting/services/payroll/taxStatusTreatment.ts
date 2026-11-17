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
 * - personal service provider (wave 6 PSP; a company or trust: Fourth Schedule para 1, "employee" para (d) and "personal service
 *   provider"; G21 p. 31, code 3601): PAYE at the trust's or company's income tax rate, 45% or 27% (SARS PAYE-GEN-01-G01-A06
 *   row 6; taxTables personalServiceProviderRates), on the balance of remuneration, whatever the class, no rebates or credits.
 *   (G21 p. 31's "in the same manner as tax on a bonus" was ruled against by the wave-6 coordinator, 2026-11-16: A06 row 6.)
 *   No UIF: UIC Act 4 of 2002 s1 "remuneration" (b) excludes an amount in para (cA) of "gross income", a PSP's.
 *   SDL: levied. G21 p. 12 (SDL Act s3(4)) excludes gross-income paras (a), (d), (e) and (eA), not (cA), and amounts to a
 *   para (c) or (d) "employee" only with a para 2(5)(a) exemption certificate, which is a labour broker's (IRP30), not a PSP's.
 *   No ETI: ETI Act 26 of 2013 s6(b) needs an ID document or permit, which a company or trust does not hold.
 *   An IRP3(b) directive for a PSP (G21 p. 16) still decides PAYE over the rate (payrollCalculator).
 * UIF, SDL and ETI stay on for every employee: only a contractor and a PSP are outside any of them.
 */
import type { PayrollEmployee, PspEntityType, ValidationResult } from './payrollTypes';
import type { EmploymentClass } from './employmentTerms';
import { getTaxYearConfig } from './taxTables';
import { pct } from './payrollExplainTypes';

export type PayeTreatment = 'tables' | 'flat_25' | 'flat_psp' | 'none';
export interface TaxStatusTreatment { paye: PayeTreatment; uif: boolean; sdl: boolean; eti: boolean }

/** The flat rate on the balance of remuneration (G21 p. 28). */
export const NON_STANDARD_RATE = 0.25;

/** On a line whose PAYE did not come from the tables: the year to date leaves it out (payrollYearToDate), so no table month re-trues it. */
export const PAYE_OUTSIDE_TABLES = 'PAYE_OUTSIDE_TABLES';

export function taxStatusTreatment(status: PayrollEmployee['taxStatus'], kind: EmploymentClass): TaxStatusTreatment {
  if (status === 'independent_contractor') return { paye: 'none', uif: false, sdl: false, eti: false };
  if (status === 'personal_service_provider') return { paye: 'flat_psp', uif: false, sdl: true, eti: false };
  return { paye: status === 'employee' && kind === 'non_standard_flat' ? 'flat_25' : 'tables', uif: true, sdl: true, eti: true };
}

/** A PSP's entity and its rate for the tax year; null for anyone else. A PSP with no entity (the 999r CHECK forbids it) throws. */
export interface PspFacts { entity: PspEntityType; rate: number }
export function pspFacts(e: Pick<PayrollEmployee, 'taxStatus' | 'pspEntityType'>, taxYear: number): PspFacts | null {
  if (e.taxStatus !== 'personal_service_provider') return null;
  if (!e.pspEntityType) throw new Error('A personal service provider has no entity type (company or trust), so its rate is unknown');
  return { entity: e.pspEntityType, rate: getTaxYearConfig(taxYear).personalServiceProviderRates[e.pspEntityType] };
}

/** Why a PSP line has no ETI (the ETI result's ineligibility reason). */
export const PSP_NO_ETI = 'Personal service provider: a company or trust, not an employee with an ID document (ETI Act s6(b)), so no ETI.';
/** Why a PSP line has no UIF. */
export const PSP_NO_UIF = 'Personal service provider: no UIF (UIC Act s1 "remuneration" (b), gross income para (cA))';

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * This line's PAYE under the treatment, from what the tables gave. `taxable` is the balance of remuneration (after allowed
 * deductions); `pspRate` is the PSP's rate (pspFacts), needed for flat_psp only.
 */
export function payeUnderTreatment(
  treatment: PayeTreatment, tables: { regular: number; annualPayment: number }, taxable: number, pspRate: number | null = null,
): { regular: number; annualPayment: number } {
  if (treatment === 'none') return { regular: 0, annualPayment: 0 };
  if (treatment === 'flat_25') return { regular: round2(NON_STANDARD_RATE * Math.max(0, taxable)), annualPayment: 0 };
  if (treatment === 'flat_psp') {
    if (pspRate == null) throw new Error('flat_psp needs the PSP rate');
    return { regular: round2(pspRate * Math.max(0, taxable)), annualPayment: 0 };
  }
  return tables;
}

/** The result stored on a line whose PAYE was not taken from the tables (its code is what the year to date reads). */
export function outsideTablesResult(treatment: 'flat_25' | 'flat_psp' | 'none', psp: PspFacts | null = null): ValidationResult[] {
  if (treatment === 'flat_psp') {
    return [{
      code: PAYE_OUTSIDE_TABLES, severity: 'warning', treatment,
      message: `Personal service provider (a ${psp?.entity ?? 'company or trust'}): PAYE is ${psp ? pct(psp.rate) : 'a flat rate'} of the payment, `
        + 'not the tables (SARS PAYE-GEN-01-G01-A06 row 6: 27% for a company or close corporation, 45% for a trust), with no UIF. '
        + 'Check the payee meets the Fourth Schedule para 1 "personal service provider" definition, and apply any IRP3(b) directive SARS issued.',
    }];
  }
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
