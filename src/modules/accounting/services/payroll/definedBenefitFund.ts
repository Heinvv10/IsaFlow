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
 *   tell a member category, so the assignment says it (db_member_retired, set by a person): X is nil and the employer's
 *   contribution is reported as 4585 / 4586, not 4472 / 4473 (BRS V25.3.0 p. 105-106; p. 54: with 4585 > 0 and 4472 = 0,
 *   3817 and 4001 must be zero).
 *
 * From there it is an employer fund contribution like any other (G21 (2027) Rev 1 p. 10): a non-cash taxable benefit under
 * 3817 (pension) or 3825 (provident) (PAYE-AE-06-G06 (2027) Rev 14, code 3817 "Value of taxable benefit i.r.o Employer's
 * pension fund contributions paid for the benefit of employee"; BRS PAYE Employer Reconciliation V25.3.0 p. 94-95),
 * deemed paid by the employee into s11F beside C, so the 27.5% / R430 000 cap binds on the total (deemedRetirementContributions,
 * payeCumulative). On the certificate 4472 / 4473 equal X and 4001 / 4003 include it (BRS p. 101-103; easyFileRetirementFields).
 *
 * Two figures per row (#1571 adversarial H): the assignment's `amount` is what the employer actually pays the fund, which
 * GL 2175 / labour and IRP5 4472 / 4473 report (BRS p. 103, "contributions paid"); X is the fringe benefit, which 3817 /
 * 3825 and the deemed 4001 / 4003 carry. Costing sets `amount` to X and keeps the payment as `dbEmployerContribution`.
 *
 * A retirement annuity fund (3828) is never a defined-benefit fund: a factor on it is refused at assignment and, should one
 * reach a line, costed at nil with an error. C is the line's 4001 (for 3817) or 4003 (for 3825) deductions MARKED as the
 * compulsory contribution to this fund (db_fund_member_contribution), after any percent_of_rfi rows are costed: an
 * unmarked one (a voluntary contribution, buy-back, another fund) is not C. A line with such deductions and none marked
 * is an error, so the run is not approved on a guessed C; a line with none at all is a non-contributory fund (C = 0). Two
 * factor rows of the same kind (refused at assignment) subtract C once, on the first. A negative X is nil.
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


const isDbRow = (c: EmployeeComponent): boolean => c.dbMemberCategoryFactor != null;

/**
 * Why a fund member category factor cannot go on this assignment, or null when it can: a recurring assignment of an employer
 * pension (3817) or provident (3825) contribution earning not created as a defined-contribution fund, whose amount (what the
 * employer pays the fund) is 0 or more, never together with percent_of_rfi (the 999s CHECK holds the last rule too).
 * `factor` is a fraction, 0 < A <= 1, four decimals.
 */
export function dbFactorRefusal(a: { componentType: string; code: string; factor: unknown; percentOfRfi: number | null; amount: number; isRecurring: boolean; fundType?: string | null }): string | null {
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
  if (a.fundType === 'defined_contribution') {
    return 'This component was created as a defined-contribution fund: its benefit is the contribution itself (para 12D(2)), so it takes no factor.';
  }
  if (!Number.isFinite(a.amount) || a.amount < 0) {
    return 'amount is what the employer pays the fund each month (0 or more); the run values the taxable benefit from the factor.';
  }
  if (!a.isRecurring) return 'A defined-benefit factor must be recurring: the fund applies it every month.';
  return null;
}

/**
 * Each defined-benefit row valued at X = round2(A x RFI - C), floored at nil, with A, B, C and the employer's payment recorded
 * on it (`rfiBase`, `dbEmployeeContribution`, `dbEmployerContribution`). Run after rfi.costPercentOfRfi (C may be a percent
 * row) and after the fund benefit is marked non-cash. Plain rows are returned as they are; the input is not mutated. Every
 * valued line carries the UNVERIFIED caution.
 */
export function costDefinedBenefitFund(components: readonly EmployeeComponent[], warnings: ValidationResult[]): EmployeeComponent[] {
  if (!components.some(isDbRow)) return [...components];
  const rfi = retirementFundingIncome(components);
  const cTaken = new Set<string>();
  return components.map((c) => {
    if (!isDbRow(c)) return c;
    const factor = Number(c.dbMemberCategoryFactor);
    const own = DEFINED_BENEFIT_CODES[normaliseSarsCode(c.component.sarsSourceCode)];
    if (c.component.componentType !== 'earning' || !own) {
      warnings.push({ code: 'DB_FUND_FACTOR_WRONG_CODE', severity: 'error',
        message: `${c.component.name} carries a defined-benefit factor but is not an employer pension (3817) or provident (3825) contribution, so it was costed at R0.00. End the assignment and assign the factor to the fund's 3817 or 3825 component.` });
      return { ...c, amount: 0 };
    }
    const paid = round2(c.amount);
    if (c.dbMemberRetired === true) {
      warnings.push({ code: 'DB_FUND_MEMBER_RETIRED', severity: 'warning',
        message: `${c.component.name}: a retired member, or a deceased member's dependant or nominee (para 12D(6)): no taxable value. The employer's ${formatMoney(paid)} is reported as ${own === '4001' ? '4585' : '4586'}.` });
      return { ...c, dbMemberCategoryFactor: factor, amount: 0, dbEmployerContribution: paid, dbMemberRetired: true };
    }
    const ownRows = components.filter((d) => d.component.componentType === 'deduction' && normaliseSarsCode(d.component.sarsSourceCode) === own);
    const marked = ownRows.filter((d) => d.dbFundMemberContribution === true);
    if (marked.length === 0 && ownRows.some((d) => d.amount > 0)) {
      warnings.push({ code: 'DB_FUND_MEMBER_CONTRIBUTION_UNMARKED', severity: 'error',
        message: `${c.component.name}: mark the employee's compulsory contribution to this fund. The line has ${own} deductions but none is marked as the contribution to the defined-benefit fund, so C (para 12D(3)) is unknown.` });
    }
    const employeeContribution = cTaken.has(own) ? 0 : round2(marked.reduce((s, d) => s + d.amount, 0));
    cTaken.add(own);
    const value = round2(factor * Math.max(0, rfi) - employeeContribution);
    warnings.push({ code: 'DB_FUND_FACTOR_UNVERIFIED', severity: 'warning',
      message: `${c.component.name} is valued as a defined-benefit contribution: ${formatPercent(factor)} of retirement-funding income `
        + `(${formatMoney(rfi)}) less the employee's ${own} contributions (${formatMoney(employeeContribution)}) = ${formatMoney(Math.max(0, value))}. `
        + `The formula is ${DB_FUND_SOURCE}. Check the figure against the fund's own valuation.` });
    if (value < 0) {
      warnings.push({ code: 'DB_FUND_BENEFIT_NIL', severity: 'warning',
        message: `${c.component.name}: the employee's ${own} contributions are more than ${formatPercent(factor)} of retirement-funding income, so the defined-benefit value is nil.` });
    }
    return { ...c, dbMemberCategoryFactor: factor, amount: Math.max(0, value), rfiBase: rfi, dbEmployeeContribution: employeeContribution, dbEmployerContribution: paid };
  });
}
