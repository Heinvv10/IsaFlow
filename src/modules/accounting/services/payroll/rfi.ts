/**
 * Retirement-funding income (RFI): the base a retirement fund's rules set contributions on (wave 5 RF, migration 975).
 * Pure.
 *
 * RFI is the sum of the line's earnings whose component is flagged `counts_as_rfi` (basic salary 3601 by default,
 * backfilled by migration 975; anything else the fund's rules name, switched on per component). An assignment with
 * `percent_of_rfi` costs round2(percent x RFI) in each run, as the fund's rules do: an employee's own contribution
 * (deduction 4001 / 4003 / 4006) or an employer's contribution (earning 3817 / 3825 / 3828, employerContributions.ts).
 *
 * RFI IS THE FUND'S CONTRIBUTION BASE ONLY, NEVER A TAX LIMIT. Since 1 March 2016 the s11F deduction is the lesser of
 * the year's cap and 27.5% of the higher of Fourth Schedule remuneration or taxable income (PAYE-GEN-01-G21 (2027)
 * Rev 1 p. 10; retirementFund.ts, payeCumulative.ts), whatever part of the package is pensionable. Nothing here feeds
 * the PAYE base: the costed amounts are ordinary contributions and benefits from then on.
 *
 * A percent row is never part of RFI itself (no circular base), and a deduction never is.
 */
import { formatMoney } from '@/lib/money/formatMoney';
import { normaliseSarsCode } from './payeAnnualPayment';
import { isEmployerFundBenefitCode, isRetirementContributionCode } from './retirementFund';
import type { EmployeeComponent, ValidationResult } from './payrollTypes';

const round2 = (n: number): number => Math.round(n * 100) / 100;

const isPercentRow = (c: EmployeeComponent): boolean => c.percentOfRfi != null;

/** The line's RFI: its earnings flagged counts_as_rfi, percent rows excluded, to the cent. */
export function retirementFundingIncome(components: readonly EmployeeComponent[]): number {
  return round2(components
    .filter((c) => c.component.componentType === 'earning' && c.component.countsAsRfi === true && !isPercentRow(c))
    .reduce((s, c) => s + c.amount, 0));
}

/**
 * Each percent_of_rfi row costed at round2(percent x RFI), with the base recorded on it (`rfiBase`). Plain rows are
 * returned as they are; the input is not mutated. A percent row with no RFI to cost on (no earning flagged) is costed
 * at nil and warned, never silently.
 */
export function costPercentOfRfi(components: readonly EmployeeComponent[]): { components: EmployeeComponent[]; rfi: number; warnings: ValidationResult[] } {
  const rfi = retirementFundingIncome(components);
  const warnings: ValidationResult[] = [];
  const costed = components.map((c) => {
    if (!isPercentRow(c)) return c;
    const percentOfRfi = Number(c.percentOfRfi);
    if (rfi <= 0) {
      warnings.push({
        code: 'RFI_NIL', severity: 'warning',
        message: `${c.component.name} is ${formatPercent(percentOfRfi)} of retirement-funding income, but no earning on this line counts as `
          + 'retirement-funding income, so it was costed at R0.00. Switch "Counts as retirement-funding income" on for the pensionable earnings, then recalculate.',
      });
    }
    return { ...c, percentOfRfi, amount: round2(percentOfRfi * Math.max(0, rfi)), rfiBase: rfi };
  });
  return { components: costed, rfi, warnings };
}

/** 0.075 → "7.5%". */
export function formatPercent(fraction: number): string {
  return `${Number((fraction * 100).toFixed(2))}%`;
}

/** "7.5% of RFI (R20 000.00)", for a payslip or a line. */
export function describePercentOfRfi(percentOfRfi: number, rfiBase: number): string {
  return `${formatPercent(percentOfRfi)} of retirement-funding income (${formatMoney(rfiBase)})`;
}

/**
 * Why `percent_of_rfi` cannot go on this component, or null when it can: a retirement contribution deduction (4001 /
 * 4003 / 4006) or an employer's fund contribution earning (3817 / 3825 / 3828). Nothing else is costed on RFI.
 */
export function percentOfRfiRefusal(componentType: string, code: string): string | null {
  if (componentType === 'deduction' && isRetirementContributionCode(code)) return null;
  if (componentType === 'earning' && isEmployerFundBenefitCode(normaliseSarsCode(code))) return null;
  return 'Only a retirement fund contribution can be a percentage of retirement-funding income: the employee\'s own (a deduction coded '
    + '4001 pension, 4003 provident or 4006 retirement annuity) or the employer\'s (an earning coded 3817, 3825 or 3828).';
}
