/**
 * An employer's contribution to a DEFINED-BENEFIT pension or provident fund (wave 6 DBF, migration 999s). Pure.
 *
 * Seventh Schedule para 12D (Income Tax Act 58 of 1962; acts.co.za, sch7_12d "Valuation of contribution"):
 * - 12D(2): a fund member category with ONLY defined-contribution components: the cash equivalent (para 2(l)) is the
 *   employer's contribution itself, no formula. That is the existing treatment of a 3817 / 3825 row WITHOUT a factor
 *   (employerContributions.ts, RF), which this file leaves exactly as it was.
 * - 12D(3): a category with components other than defined-contribution ones (defined-benefit or mixed) is valued
 *
 *     X = (A x B) - C
 *
 *   X the amount to be determined; A the fund member category factor for the employee's category (a fraction: 0.12 = 12%);
 *   B the employee's retirement-funding income (rfi.ts); C the employee's own contributions for the period, excluding
 *   additional voluntary contributions and buy-back. The symbol definitions are the Act's text; the formula itself is an
 *   image on that page, so its operator form is UNVERIFIED (as read in the Sage Payroll Tax Pocket Guide 2025-2026
 *   s7.12.2 and by the oracle cases db-fund-12d-category-factor / db-fund-12d-s11f-cap-binds). 12D(2) and the opening
 *   words of 12D(3) were substituted by s33(g)/(h) of the Taxation Laws Amendment Act 42 of 2024 (GG 51826); its
 *   commencement date is UNVERIFIED. Every line that costs one carries the DB_FUND_FACTOR_UNVERIFIED caution (spec rule 5).
 * - 12D(4): A is the value on the fund's certificate for the category; 12D(5)(a): the method is set by regulations
 *   (GN R.17 of 2016, GG 39582; GN 1262 of 2015), NOT READ here: the payroll stores the certified factor, never derives it.
 * - 12D(6): no value for a category of retired members, or of dependants or nominees of deceased members. The run cannot
 *   tell a member category, so a line that pays a pension or annuity (3603 / 3610, foreign 3653 / 3660) is taken as a
 *   retired member's and its factor row is costed at nil with an error, for a person to end the assignment.
 *
 * From there it is an employer fund contribution like any other (G21 (2027) Rev 1 p. 10): a non-cash taxable benefit under
 * 3817 (pension) or 3825 (provident) (PAYE-AE-06-G06 (2027) Rev 14, code 3817 "Value of taxable benefit i.r.o Employer's
 * pension fund contributions paid for the benefit of employee"; BRS PAYE Employer Reconciliation V25.3.0 p. 94-95),
 * deemed paid by the employee into s11F beside C, so the 27.5% / R430 000 cap binds on the total (deemedRetirementContributions,
 * payeCumulative). On the certificate 4472 / 4473 equal X and 4001 / 4003 include it (BRS p. 101-103; easyFileRetirementFields).
 *
 * A retirement annuity fund (3828) is never a defined-benefit fund: a factor on it is refused at assignment and, should one
 * reach a line, costed at nil with an error. C is the line's deductions under the matching employee code (3817 -> 4001,
 * 3825 -> 4003), after any percent_of_rfi rows are costed. NAMED LIMITS: the payroll does not separate additional voluntary
 * contributions or buy-back from a 4001 / 4003, so C includes any entered there (X understated); an employee who also
 * belongs to a second fund of the same kind has both funds' 4001 in C; in either case enter the fund's figure as an amount.
 * A negative X (the employee pays more than the factor) is nil.
 */
import { formatMoney } from '@/lib/money/formatMoney';
import { normaliseSarsCode } from './payeAnnualPayment';
import { formatPercent, retirementFundingIncome } from './rfi';
import type { EmployeeComponent, ValidationResult } from './payrollTypes';

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** The benefit code a factor may go on, and the employee's own contribution code for the same fund. */
export const DEFINED_BENEFIT_CODES: Readonly<Record<string, string>> = { '3817': '4001', '3825': '4003' };

export const DB_FUND_SOURCE = 'Seventh Schedule para 12D(3), X = (A x B) - C (A the fund member category factor on the fund\'s '
  + 'certificate, B retirement-funding income, C the employee\'s own contributions); the formula\'s form is an image in the Act '
  + 'and read from the Sage Payroll Tax Pocket Guide 2025-2026 s7.12.2: UNVERIFIED';

/** A pension or annuity paid on the line (SARS 3603 / 3610, foreign 3653 / 3660): para 12D(6) gives a retired member no value. */
const RETIRED_MEMBER_CODES = new Set(['3603', '3610', '3653', '3660']);

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
  const retired = components.some((c) => c.component.componentType === 'earning' && RETIRED_MEMBER_CODES.has(normaliseSarsCode(c.component.sarsSourceCode)));
  return components.map((c) => {
    if (!isDbRow(c)) return c;
    const factor = Number(c.dbMemberCategoryFactor);
    const own = DEFINED_BENEFIT_CODES[normaliseSarsCode(c.component.sarsSourceCode)];
    if (c.component.componentType !== 'earning' || !own) {
      warnings.push({ code: 'DB_FUND_FACTOR_WRONG_CODE', severity: 'error',
        message: `${c.component.name} carries a defined-benefit factor but is not an employer pension (3817) or provident (3825) contribution, so it was costed at R0.00. End the assignment and assign the factor to the fund's 3817 or 3825 component.` });
      return { ...c, amount: 0 };
    }
    if (retired) {
      warnings.push({ code: 'DB_FUND_RETIRED_MEMBER', severity: 'error',
        message: `${c.component.name} carries a defined-benefit factor on a line that pays a pension or annuity: para 12D(6) gives a retired member's category no value, so it was costed at R0.00. End the assignment if the employee has retired.` });
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
