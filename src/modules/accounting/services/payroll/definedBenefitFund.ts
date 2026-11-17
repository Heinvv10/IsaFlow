/**
 * An employer's contribution to a DEFINED-BENEFIT pension or provident fund (wave 6 DBF, migration 999s). Pure.
 *
 * For a defined-contribution fund the employer's taxable benefit is the contribution it pays (employerContributions.ts, RF).
 * For a defined-benefit component it is not: the Seventh Schedule para 12D(3) values it from the fund member category factor
 * the fund publishes for the employee's category,
 *
 *     X = (A x B) - C
 *
 * X the value of the benefit; A the fund member category factor (a fraction: 0.12 = 12%); B the employee's
 * retirement-funding income for the period (rfi.ts); C the employee's own contributions to that fund for the period.
 * Source: Sage Payroll Tax Pocket Guide 2025-2026 s7.12.2 ("X = A x B - C"), the same reading as the oracle cases
 * db-fund-12d-category-factor and db-fund-12d-s11f-cap-binds. UNVERIFIED: the Seventh Schedule para 12D text itself was
 * not fetched (SARS publishes the Act only through LexisNexis) and G21 (2027) has no para 12D section, so every line that
 * costs one carries the DB_FUND_FACTOR_UNVERIFIED caution (wave-6 spec rule 5).
 *
 * From there it is an employer fund contribution like any other (G21 (2027) Rev 1 p. 10): a non-cash taxable benefit under
 * 3817 (pension) or 3825 (provident) (PAYE-AE-06-G06 (2027) Rev 14, code 3817 "Value of taxable benefit i.r.o Employer's
 * pension fund contributions paid for the benefit of employee"; BRS PAYE Employer Reconciliation V25.3.0 p. 94-95),
 * deemed paid by the employee into s11F beside C, so the 27.5% / R430 000 cap binds on the total (deemedRetirementContributions,
 * payeCumulative). On the certificate 4472 / 4473 equal X and 4001 / 4003 include it (BRS p. 101-103; easyFileRetirementFields).
 *
 * A retirement annuity fund (3828) is never a defined-benefit fund: a factor on it is refused at assignment and, should one
 * reach a line, costed at nil with an error. C is the line's deductions under the matching employee code (3817 -> 4001,
 * 3825 -> 4003), after any percent_of_rfi rows are costed. NAMED LIMIT: an employee who also belongs to a second fund of
 * the same kind (a defined-contribution pension fund beside the defined-benefit one) has both funds' 4001 in C; the
 * fund's figure must then be entered by hand as an amount. A negative X (the employee pays more than the factor) is nil.
 */
import { formatMoney } from '@/lib/money/formatMoney';
import { normaliseSarsCode } from './payeAnnualPayment';
import { formatPercent, retirementFundingIncome } from './rfi';
import type { EmployeeComponent, ValidationResult } from './payrollTypes';

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** The benefit code a factor may go on, and the employee's own contribution code for the same fund. */
export const DEFINED_BENEFIT_CODES: Readonly<Record<string, string>> = { '3817': '4001', '3825': '4003' };

export const DB_FUND_SOURCE = 'Seventh Schedule para 12D(3), X = A x B - C, as read in the Sage Payroll Tax Pocket Guide 2025-2026 s7.12.2 '
  + '(the Act itself not fetched: UNVERIFIED)';

const isDbRow = (c: EmployeeComponent): boolean => c.dbMemberCategoryFactor != null;

/**
 * Why a fund member category factor cannot go on this assignment, or null when it can: a recurring, amount-0 assignment of an
 * employer pension (3817) or provident (3825) contribution earning, never together with percent_of_rfi (the CHECK on
 * payroll_employee_components, migration 999s, holds the last rule too). `factor` is a fraction, 0 < A <= 1, four decimals.
 */
export function dbFactorRefusal(a: { componentType: string; code: string; factor: unknown; percentOfRfi: number | null; amount: number; isRecurring: boolean }): string | null {
  const f = a.factor;
  if (typeof f !== 'number' || !Number.isFinite(f) || f <= 0 || f > 1 || Math.abs(Math.round(f * 10_000) - f * 10_000) > 1e-6) {
    return 'dbMemberCategoryFactor must be a fraction above 0 and at most 1, to four decimals (0.12 = 12%).';
  }
  if (a.percentOfRfi !== null) {
    return 'A defined-benefit factor and a percentage of retirement-funding income cannot be on the same assignment: the factor values the '
      + 'employer\'s defined-benefit contribution (para 12D), a percentage costs a defined-contribution one. Choose one.';
  }
  if (a.componentType !== 'earning' || !DEFINED_BENEFIT_CODES[normaliseSarsCode(a.code)]) {
    return 'A defined-benefit factor goes only on an employer pension (3817) or provident (3825) fund contribution: a retirement annuity '
      + 'fund is never a defined-benefit fund.';
  }
  if (a.amount !== 0) return 'A defined-benefit contribution is valued by each run from the factor: send amount 0 with dbMemberCategoryFactor.';
  if (!a.isRecurring) return 'A defined-benefit factor must be recurring: the fund applies it every month.';
  return null;
}

/**
 * Each defined-benefit row valued at X = round2(A x RFI - C), floored at nil, with A, B and C recorded on it (`rfiBase`,
 * `dbEmployeeContribution`). Run after rfi.costPercentOfRfi (C may be a percent row) and after the fund benefit is marked
 * non-cash. Plain rows are returned as they are; the input is not mutated. Every line with one carries the UNVERIFIED caution.
 */
export function costDefinedBenefitFund(components: readonly EmployeeComponent[], warnings: ValidationResult[]): EmployeeComponent[] {
  if (!components.some(isDbRow)) return [...components];
  const rfi = retirementFundingIncome(components);
  return components.map((c) => {
    if (!isDbRow(c)) return c;
    const factor = Number(c.dbMemberCategoryFactor);
    const own = DEFINED_BENEFIT_CODES[normaliseSarsCode(c.component.sarsSourceCode)];
    if (c.component.componentType !== 'earning' || !own) {
      warnings.push({ code: 'DB_FUND_FACTOR_WRONG_CODE', severity: 'error',
        message: `${c.component.name} carries a defined-benefit factor but is not an employer pension (3817) or provident (3825) contribution, so it was costed at R0.00. End the assignment and assign the factor to the fund's 3817 or 3825 component.` });
      return { ...c, amount: 0 };
    }
    const employeeContribution = round2(components
      .filter((d) => d.component.componentType === 'deduction' && normaliseSarsCode(d.component.sarsSourceCode) === own)
      .reduce((s, d) => s + d.amount, 0));
    const value = round2(factor * Math.max(0, rfi) - employeeContribution);
    warnings.push({ code: 'DB_FUND_FACTOR_UNVERIFIED', severity: 'warning',
      message: `${c.component.name} is valued as a defined-benefit contribution: ${formatPercent(factor)} of retirement-funding income `
        + `(${formatMoney(rfi)}) less the employee's ${own} contributions (${formatMoney(employeeContribution)}) = ${formatMoney(Math.max(0, value))}. `
        + `The formula is ${DB_FUND_SOURCE}. Check the figure against the fund's own valuation.` });
    if (value < 0) {
      warnings.push({ code: 'DB_FUND_BENEFIT_NIL', severity: 'warning',
        message: `${c.component.name}: the employee's ${own} contributions are more than ${formatPercent(factor)} of retirement-funding income, so the defined-benefit value is nil.` });
    }
    return { ...c, dbMemberCategoryFactor: factor, amount: Math.max(0, value), rfiBase: rfi, dbEmployeeContribution: employeeContribution };
  });
}
