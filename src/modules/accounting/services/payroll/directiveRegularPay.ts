/**
 * PAYE on regular pay under an IRP3(b) fixed-percentage or IRP3(c) fixed-amount SARS directive (wave 5 DR). Pure.
 *
 * Sources, all PAYE-GEN-01-G21 (2027 tax year) Rev 1:
 * - p. 15 "Rules related to tax directives": a directive "is only valid for the tax year or period stated thereon";
 *   "Employers may under no circumstances deviate from the instructions of the directive"; "Employers must apply the
 *   percentage of employees' tax as indicated on the directive prior to considering allowable deductions for employees'
 *   tax purposes (e.g. pension, retirement annuity fund contributions, etc.)". So the rate is on remuneration BEFORE the
 *   retirement and donation deductions, and the RA does not reduce the base.
 * - p. 16: IRP3(b) "Employees' tax to be deducted at a fixed percentage (e.g. commission agents/personal service
 *   provider)"; IRP3(c) "Employees' Tax to be deducted at a fixed amount (e.g. Paragraph 11 of the Fourth Schedule
 *   (hardship) / assessed loss carried forward)".
 * - p. 17 (Fourth Schedule para 11): the Commissioner may direct the employer to "deduct a specified amount of employees'
 *   tax from the remuneration of an employee" or "an amount ... determined in accordance with a specified rate".
 * - p. 28 (non-standard employment): "Where the employer is in possession of a tax directive in respect of an employee who
 *   is in non-standard employment, employees' tax must be deducted in accordance with the directive"; p. 29 (commission):
 *   the employer "MUST deduct employees' tax according to the instructions on the tax directive" and it reflects as PAYE.
 *   So a directive overrides the tax-status treatment (taxStatusTreatment: the flat 25%, and the tables).
 *
 * UNVERIFIED (each carries a warning on the line; G21 is silent):
 * - whether an IRP3(c) amount is per payment or per year: read as per monthly period;
 * - an annual payment (3605) paid under a directive: the tables tax it, on this period alone;
 * - the first table month after a directive ends: its months stay out of the year to date (payrollYearToDate, as a flat
 *   month), so the tables restart on the months they taxed.
 * What does not change: UIF, SDL (on remuneration after the para 2(4) deductions, G21 p. 12) and ETI.
 */
import { formatMoney } from '@/lib/money/formatMoney';
import { PAYE_OUTSIDE_TABLES } from './taxStatusTreatment';
import type { RegularPayDirectiveType } from './taxDirectiveKinds';
import type { ValidationResult } from './payrollTypes';

export interface RegularPayDirective {
  id: string;
  number: string | null;
  type: RegularPayDirectiveType;
  /** fixed_percentage: the fraction of remuneration (0.2 = 20%). */
  rate: number | null;
  /** fixed_amount: rands of PAYE a period. */
  fixedAmount: number | null;
  /** The last day it is in force, YYYY-MM-DD: its expiry date, else the end of its tax year (G21 p. 15). */
  endsOn: string;
}

/** What the run reads for one employee (payrollRunRegularDirective): the directive in force this period, and one in force last period only. */
export interface RegularPayDirectiveState {
  current: RegularPayDirective | null;
  ended: RegularPayDirective | null;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
const pct = (rate: number): string => `${round2(rate * 100)}%`;
const label = (d: RegularPayDirective): string => `SARS directive ${d.number ?? d.id}`;

/** The figures of a directive as stored on the line's result (the approval gate and the year to date read the code). */
const recorded = (d: RegularPayDirective) => ({ id: d.id, number: d.number, type: d.type, rate: d.rate, fixedAmount: d.fixedAmount });

export function regularPayDirectivePaye(d: RegularPayDirective, line: {
  /** Periodic remuneration before any deduction (payrollLineRemuneration). */
  periodicRemuneration: number;
  /** Taxable annual payments (3605) on the line. */
  annualPayments: number;
  /** The tables' PAYE on those annual payments, costed as a first period (the line is off the tables). */
  tablesAnnualPayment: number;
  contractor: boolean;
}): { regular: number; annualPayment: number; results: ValidationResult[] } {
  const base = Math.max(0, line.periodicRemuneration);
  const regular = d.type === 'fixed_percentage'
    ? round2((d.rate ?? 0) * base)
    : base > 0 ? round2(d.fixedAmount ?? 0) : 0;
  const how = d.type === 'fixed_percentage'
    ? `${pct(d.rate ?? 0)} of ${formatMoney(base)} remuneration before deductions (IRP3(b); G21 p. 15: the percentage applies before retirement fund and other allowable deductions)`
    : base > 0
      ? `the fixed ${formatMoney(d.fixedAmount ?? 0)} it directs (IRP3(c), G21 p. 16-17)`
      : 'nil: no regular remuneration was paid this period to deduct the fixed amount from';
  const results: ValidationResult[] = [{
    code: PAYE_OUTSIDE_TABLES, severity: 'info', treatment: 'directive', directive: recorded(d),
    message: `PAYE on regular pay is ${label(d)}: ${how}, not the tables (G21 p. 15: employers may not deviate from a directive). `
      + 'This month stays out of the year to date the tables true up.',
  }];
  if (d.type === 'fixed_amount') {
    results.push({
      code: 'DIRECTIVE_FIXED_AMOUNT_PER_PERIOD', severity: 'warning',
      message: `UNVERIFIED: ${label(d)} is applied as ${formatMoney(d.fixedAmount ?? 0)} every monthly period. The SARS guide (G21 p. 16-17) does not say `
        + 'whether a fixed-amount directive is per payment or for the year: check the directive\'s wording.',
    });
  }
  if (line.annualPayments > 0) {
    results.push({
      code: 'DIRECTIVE_ANNUAL_PAYMENT_ON_TABLES', severity: 'warning',
      message: `UNVERIFIED: the ${formatMoney(line.annualPayments)} annual payment (3605) is taxed by the tables (${formatMoney(line.tablesAnnualPayment)}), `
        + `not by ${label(d)}: the SARS guide (G21) does not say how a regular-pay directive treats a bonus. Check the directive's wording.`,
    });
  }
  if (line.contractor) {
    results.push({
      code: 'DIRECTIVE_FOR_CONTRACTOR', severity: 'warning',
      message: `This employee's tax status is independent contractor, but ${label(d)} directs PAYE, so it was deducted (G21 p. 15). `
        + 'UIF, SDL and ETI stay off. A directive means SARS treats the payments as remuneration: check the tax status.',
    });
  }
  return { regular, annualPayment: line.annualPayments > 0 ? round2(line.tablesAnnualPayment) : 0, results };
}

/** The first period after a directive ended: the tables apply again (a warning, UNVERIFIED). Null when none ended. */
export function directiveEndedResult(state: RegularPayDirectiveState | undefined): ValidationResult | null {
  const ended = state?.current ? null : state?.ended;
  if (!ended) return null;
  return {
    code: 'DIRECTIVE_ENDED', severity: 'warning',
    message: `UNVERIFIED: ${label(ended)} ended on ${ended.endsOn} (a directive is valid only for the period stated on it, G21 p. 15), so the tables apply `
      + 'from this period. The months it covered stay out of the year to date, so the tables do not true them up; the SARS guide does not say '
      + 'how the tables restart after a directive. Check with SARS whether a new directive applies.',
  };
}
