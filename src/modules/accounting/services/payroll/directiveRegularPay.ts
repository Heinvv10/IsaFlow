/**
 * PAYE on regular pay under an IRP3(b) fixed-percentage or IRP3(c) fixed-amount SARS directive (wave 5 DR). Pure.
 *
 * Sources, all PAYE-GEN-01-G21 (2027 tax year) Rev 1:
 * - p. 15 "Rules related to tax directives": a directive "is only valid for the tax year or period stated thereon";
 *   "Employers may under no circumstances deviate from the instructions of the directive"; "Employers must apply the
 *   percentage of employees' tax as indicated on the directive prior to considering allowable deductions for employees'
 *   tax purposes (e.g. pension, retirement annuity fund contributions, etc.)". So the rate is on the month's whole
 *   remuneration, an annual payment (3605) included and a 3605 clawback netted in, BEFORE the retirement and donation
 *   deductions: the RA does not reduce the base.
 * - p. 16: IRP3(b) "Employees' tax to be deducted at a fixed percentage (e.g. commission agents/personal service
 *   provider)"; IRP3(c) "Employees' Tax to be deducted at a fixed amount (e.g. Paragraph 11 of the Fourth Schedule
 *   (hardship) / assessed loss carried forward)".
 * - p. 17 (Fourth Schedule para 11): the Commissioner may direct the employer to "deduct a specified amount of employees'
 *   tax from the remuneration of an employee" or "an amount ... determined in accordance with a specified rate". Tax is
 *   deducted FROM the remuneration, so what is withheld is capped at the cash the line pays (capDirectivePaye).
 * - p. 28 (non-standard employment): "Where the employer is in possession of a tax directive in respect of an employee who
 *   is in non-standard employment, employees' tax must be deducted in accordance with the directive"; p. 29 (commission):
 *   the employer "MUST deduct employees' tax according to the instructions on the tax directive" and it reflects as PAYE.
 *   So a directive overrides the tax-status treatment (taxStatusTreatment: the flat 25%, and the tables).
 *
 * UNVERIFIED (each carries a warning on the line; G21 is silent):
 * - whether an IRP3(c) amount is per payment or per year: read as per monthly period;
 * - an annual payment (3605) paid under a FIXED-AMOUNT directive: the tables tax it, on this period alone;
 * - the first table month after a directive ends: its months stay out of the year to date (payrollYearToDate, as a flat
 *   month), so the tables restart on the months they taxed;
 * - a directive whose window starts or ends inside the month: it applies to the whole month when in force on the pay
 *   date, else not at all (DIRECTIVE_PARTIAL_PERIOD, payrollRunRegularDirective).
 * What does not change: UIF, SDL (on remuneration after the para 2(4) deductions, G21 p. 12) and ETI.
 */
import { formatMoney } from '@/lib/money/formatMoney';
import { PAYE_OUTSIDE_TABLES } from './taxStatusTreatment';
import type { ValidationResult } from './payrollTypes';

interface DirectiveIdentity {
  id: string;
  number: string | null;
  /** The last day it is in force, YYYY-MM-DD: its expiry date, else the end of its tax year (G21 p. 15). */
  endsOn: string;
  /** YYYY-MM-DD. */
  effectiveDate: string;
}
/** A figure-less row never reaches here: the loader reports it as invalid (payrollRunRegularDirective). */
export type RegularPayDirective = DirectiveIdentity & (
  | { type: 'fixed_percentage'; /** The fraction of remuneration (0.2 = 20%), above 0. */ rate: number; fixedAmount: null }
  | { type: 'fixed_amount'; rate: null; /** Rands of PAYE a period, above 0. */ fixedAmount: number }
);

/** What the run reads for one employee (payrollRunRegularDirective.loadRegularPayDirectives). */
export interface RegularPayDirectiveState {
  /** In force on the judge date (the run's pay date, else the period's last day). */
  current: RegularPayDirective | null;
  /** In force on the previous period's last day and not on this judge date: the first month back on the tables. */
  ended: RegularPayDirective | null;
  /** Windows that start or end inside the period (applied or not): warned, never silent. */
  partial?: Array<{ directive: RegularPayDirective; applied: boolean }>;
  /** Two or more in force: none applies and approval refuses (`regular_directive_overlap`). */
  overlapping?: string[];
  /** In force but carrying no usable rate or amount (written outside the route): none applies, approval refuses. */
  invalid?: string[];
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
const pct = (rate: number): string => `${round2(rate * 100)}%`;
/** Its number when one was captured, else a plain name: never the row id. */
const label = (d: { number: string | null }): string => (d.number?.trim() ? `SARS directive ${d.number.trim()}` : 'the SARS directive');

/** The figures of a directive as stored on the line's result (the approval gate and the year to date read the code). */
const recorded = (d: RegularPayDirective) => ({ id: d.id, number: d.number, type: d.type, rate: d.rate, fixedAmount: d.fixedAmount });

export function regularPayDirectivePaye(d: RegularPayDirective, line: {
  /** Periodic remuneration before any deduction, signed as costed (payrollLineAccumulate). */
  periodic: number;
  /** Taxable annual payments (3605) before any deduction, signed: a clawback is negative. */
  annual: number;
  /** The tables' PAYE on positive annual payments, costed as a first period (fixed-amount directive only). */
  tablesAnnualPayment: number;
}): { regular: number; annualPayment: number; results: ValidationResult[] } {
  const periodic = Math.max(0, line.periodic);
  // A clawback reduces the month's remuneration: netted into the base, never below nil.
  const base = Math.max(0, line.periodic + line.annual);
  let regular: number;
  let annualPayment: number;
  let how: string;
  if (d.type === 'fixed_percentage') {
    annualPayment = line.annual > 0 ? round2(d.rate * line.annual) : 0;
    regular = line.annual > 0 ? round2(d.rate * periodic) : round2(d.rate * base);
    how = `${pct(d.rate)} of ${formatMoney(base)} remuneration before deductions (IRP3(b); G21 p. 15: the percentage applies before retirement fund `
      + 'and other allowable deductions, annual payments included)';
  } else {
    // On regular pay: a month with no periodic remuneration (a bonus alone) deducts no fixed amount.
    const paysRegular = periodic > 0 && base > 0;
    regular = paysRegular ? d.fixedAmount : 0;
    annualPayment = line.annual > 0 ? round2(line.tablesAnnualPayment) : 0;
    how = paysRegular ? `the fixed ${formatMoney(d.fixedAmount)} it directs (IRP3(c), G21 p. 16-17)`
      : 'nil: no regular remuneration was paid this period to deduct the fixed amount from';
  }
  const results: ValidationResult[] = [{
    code: PAYE_OUTSIDE_TABLES, severity: 'info', treatment: 'directive', directive: recorded(d),
    message: `PAYE on regular pay is ${label(d)}: ${how}, not the tables (G21 p. 15: employers may not deviate from a directive). `
      + 'This month stays out of the year to date the tables true up.',
  }];
  if (d.type === 'fixed_amount') {
    results.push({
      code: 'DIRECTIVE_FIXED_AMOUNT_PER_PERIOD', severity: 'warning',
      message: `UNVERIFIED: ${label(d)} is applied as ${formatMoney(d.fixedAmount)} every monthly period. The SARS guide (G21 p. 16-17) does not say `
        + 'whether a fixed-amount directive is per payment or for the year: check the directive\'s wording.',
    });
    if (line.annual > 0) {
      results.push({
        code: 'DIRECTIVE_ANNUAL_PAYMENT_ON_TABLES', severity: 'warning',
        message: `UNVERIFIED: the ${formatMoney(line.annual)} annual payment (3605) is taxed by the tables (${formatMoney(line.tablesAnnualPayment)}) beside `
          + `the fixed amount of ${label(d)}: the SARS guide (G21) does not say how a fixed-amount directive treats a bonus. Check the directive's wording.`,
      });
    }
  }
  return { regular, annualPayment, results };
}

/** On an independent contractor's line, a regular-pay directive is not applied (Hein's ruling, #1266 round 2): an error the approval gate refuses. */
export const DIRECTIVE_FOR_CONTRACTOR = 'DIRECTIVE_FOR_CONTRACTOR';
export function contractorDirectiveResult(d: RegularPayDirective): ValidationResult {
  return {
    code: DIRECTIVE_FOR_CONTRACTOR, severity: 'error',
    message: `This employee's tax status is independent contractor, but ${label(d)} is approved for them, so it was not applied and the run `
      + 'cannot be approved. A directive means SARS treats the payments as remuneration: change the tax status first, or cancel the directive.',
  };
}

/**
 * Tax is deducted FROM the remuneration (G21 p. 17; Fourth Schedule para 2): a directive's PAYE above the cash the line
 * pays (gross cash less employee UIF and any lump-sum directive PAYE) is withheld only up to it, regular pay first, and
 * the shortfall is named. Other deductions rank after PAYE (DEDUCTIONS_EXCEED_PAY still judges them).
 */
export function capDirectivePaye(
  split: { regular: number; annualPayment: number }, available: number, d: RegularPayDirective,
): { regular: number; annualPayment: number; result: ValidationResult | null } {
  const room = Math.max(0, round2(available));
  const shortfall = round2(split.regular + split.annualPayment - room);
  if (shortfall <= 0) return { ...split, result: null };
  const regular = Math.min(split.regular, room);
  const annualPayment = round2(Math.min(split.annualPayment, room - regular));
  return {
    regular: round2(regular), annualPayment,
    result: {
      code: 'DIRECTIVE_PAYE_CAPPED', severity: 'warning',
      message: `${label(d)} directs ${formatMoney(split.regular + split.annualPayment)} of PAYE, but the month pays only ${formatMoney(room)} of cash `
        + `after UIF, so ${formatMoney(room)} was withheld and ${formatMoney(shortfall)} was not (tax is deducted from the remuneration, `
        + 'G21 p. 17). Ask SARS whether the shortfall carries forward, and check the directive.',
    },
  };
}

/** The warnings the run's reading of the directives adds to a line (ended, partial month, overlap, unusable). */
export function directiveStateResults(state: RegularPayDirectiveState | undefined): ValidationResult[] {
  if (!state) return [];
  const out: ValidationResult[] = [];
  if (state.ended && !state.current) {
    out.push({
      code: 'DIRECTIVE_ENDED', severity: 'warning',
      message: `UNVERIFIED: ${label(state.ended)} ended on ${state.ended.endsOn} (a directive is valid only for the period stated on it, G21 p. 15), so the tables apply `
        + 'from this period. The months it covered stay out of the year to date, so the tables do not true them up; the SARS guide does not say '
        + 'how the tables restart after a directive. Check with SARS whether a new directive applies.',
    });
  }
  for (const { directive: d, applied } of state.partial ?? []) {
    out.push({
      code: 'DIRECTIVE_PARTIAL_PERIOD', severity: 'warning',
      message: `UNVERIFIED: ${label(d)} runs from ${d.effectiveDate} to ${d.endsOn}, which starts or ends inside this period. `
        + (applied ? 'It is in force on the pay date, so it taxes the whole month. ' : 'It is not in force on the pay date, so the month is on the tables. ')
        + 'The SARS guide does not say how a directive applies to part of a month: check the directive\'s wording.',
    });
  }
  if ((state.overlapping?.length ?? 0) > 1) {
    out.push({
      code: 'DIRECTIVE_OVERLAP', severity: 'error',
      message: `Two approved regular-pay directives are in force this period (${state.overlapping!.join(', ')}), so neither was applied and the run `
        + 'cannot be approved. Cancel one, or give it an expiry date, then recalculate.',
    });
  }
  if ((state.invalid?.length ?? 0) > 0) {
    out.push({
      code: 'DIRECTIVE_INVALID', severity: 'error',
      message: `Approved regular-pay directive ${state.invalid!.join(', ')} carries no rate or amount above nil, so it was not applied and the run `
        + 'cannot be approved. Cancel it and capture the directive again.',
    });
  }
  return out;
}
