/**
 * Overtime hours and reimbursive travel km on a pay run (wave 6 RI, migration 999t). Pure.
 *
 * OVERTIME. An hours row carrying `rateMultiplier` is overtime: amount = hours x the hourly rate x the multiplier, priced on
 * the server in whole cents (overtimeAmountCents) and stored, so the line costs what was entered. The multiplier is 1.5
 * (BCEA 75 of 1997 s10(2): "at least one and one-half times the employee's wage for overtime worked") or 2.0 (s16(1):
 * Sunday work, "double the employee's wage for each hour worked" unless the employee ordinarily works on a Sunday;
 * s18(2)(b)(i): public-holiday work, "at least double"). G21 (2027) p. 33: overtime is taxed with the period's pay (3607).
 * The hourly rate is the employee's, or for a monthly employee their basic pay / (hours a week x 52 / 12).
 * BCEA s6(3): the Minister's earnings-threshold determination takes employees above it out of the overtime sections, so an
 * employee earning above it gets a multiplier only by contract: warned OVERTIME_ABOVE_BCEA_THRESHOLD, never refused.
 *
 * TRAVEL. A km row is a reimbursive travel allowance at amount / km a km. SARS "Guide for employers in respect of
 * allowances" (Travel Allowance, from 1 March 2018) and the SARS travel FAQ:
 *   - the part within the prescribed rate a km (taxTables.reimbursiveRatePerKm) is not subject to employees' tax: code
 *     3703 when nothing above the rate and no other travel compensation (a 3701 allowance) is paid, else code 3702;
 *   - the part above the rate, "irrespective of the kilometers travelled", is remuneration: code 3722, PAYE, UIF and SDL.
 * There is no distance threshold (coordinator ruling 2026-11-16: the 8 000 / 12 000 km limits were removed from 1 March
 * 2018), so km to date never change the figure (the oracle's ri-reimbursive-above-prescribed-3702-3722 states 8 000 prior km).
 */
import { formatMoney } from '@/lib/money/formatMoney';
import { normaliseSarsCode } from './payeAnnualPayment';
import { TRAVEL_CODE } from './fringeBenefits';
import { getTaxYearConfig } from './taxTables';
import type { EmployeeComponent, PayrollEmployee, ValidationResult } from './payrollTypes';

export const OVERTIME_MULTIPLIERS: readonly number[] = [1.5, 2];
export const TRAVEL_WITHIN_RATE_CODE = '3702';
export const TRAVEL_NOT_TAXABLE_CODE = '3703';
export const TRAVEL_EXCESS_CODE = '3722';
export const OVERTIME_ABOVE_BCEA_THRESHOLD = 'OVERTIME_ABOVE_BCEA_THRESHOLD';
export const TRAVEL_RATE_NOT_LOADED = 'TRAVEL_RATE_NOT_LOADED';
const WEEKS_PER_MONTH = 52 / 12;

/**
 * BCEA s6(3) earnings thresholds a year, by the date each took effect. UNVERIFIED against the Gazette text (read through
 * secondary sources only): R261 748.45 from 1 April 2025; R269 600.90 from 1 May 2026 (GN 7384, GG 54544, 17 April 2026).
 * The warning is advice, so an unverified figure gives a caution, never a refusal.
 */
const BCEA_THRESHOLDS: ReadonlyArray<{ from: string; annual: number }> = [
  { from: '2025-04-01', annual: 261_748.45 },
  { from: '2026-05-01', annual: 269_600.9 },
];

export function bceaThresholdAt(dateIso: string): number | null {
  return [...BCEA_THRESHOLDS].reverse().find((t) => t.from <= dateIso)?.annual ?? null;
}

const cents = (n: number) => Math.round(n * 100);
const isOvertime = (c: EmployeeComponent) => c.rateMultiplier != null && c.quantityUnit === 'hour';
const isTravel = (c: EmployeeComponent) => c.quantityUnit === 'km' && c.component.componentType === 'earning';

/** Rows the hours-and-days machinery (payrollRunHours, the grid's hours cell) must leave alone: overtime and km. */
export const isRunInputUnitRow = (c: Pick<EmployeeComponent, 'rateMultiplier' | 'quantityUnit'>): boolean =>
  c.rateMultiplier != null || c.quantityUnit === 'km';

/** hours x rate x multiplier in cents: hours and rate to hundredths first, the multiplier (1.5 or 2) exact. */
export const overtimeAmountCents = (hours: number, hourlyRate: number, multiplier: number): number =>
  Math.round((Math.round(hours * 100) * Math.round(hourlyRate * 100) * multiplier) / 100);

/** The hourly rate overtime is priced at, to the cent; null when it cannot be told (the write refuses, naming what is missing). */
export function overtimeHourlyRate(
  employee: Pick<PayrollEmployee, 'payBasis' | 'hourlyRate' | 'dailyRate' | 'hoursPerDay' | 'hoursPerWeek'>, monthlyBasic: number,
): number | null {
  const rate = employee.payBasis === 'hourly' ? employee.hourlyRate
    : employee.payBasis === 'daily' ? (employee.dailyRate != null && employee.hoursPerDay ? employee.dailyRate / employee.hoursPerDay : null)
      : employee.hoursPerWeek && monthlyBasic > 0 ? monthlyBasic / (employee.hoursPerWeek * WEEKS_PER_MONTH) : null;
  return rate == null || !(rate > 0) ? null : cents(rate) / 100;
}

/** Overtime hours on the line, for ETI (ETI Act s7(5) counts hours worked, overtime included; version 8). */
export const overtimeHoursOf = (components: EmployeeComponent[]): number =>
  components.filter(isOvertime).reduce((h, c) => h + Number(c.quantity ?? 0), 0);

/**
 * The line's components with each km row split as SARS treats it: the part within the prescribed rate (3702 / 3703, not
 * taxed, not UIF or SDL remuneration) and the excess (3722, taxed with periodic pay, UIF and SDL). Other rows unchanged.
 */
export function splitTravelRows(components: EmployeeComponent[], taxYear: number): { components: EmployeeComponent[]; warnings: ValidationResult[] } {
  if (!components.some(isTravel)) return { components, warnings: [] };
  const prescribed = getTaxYearConfig(taxYear).reimbursiveRatePerKm;
  const otherCompensation = components.some((c) => c.component.componentType === 'earning' && c.amount !== 0
    && normaliseSarsCode(c.component.sarsSourceCode) === TRAVEL_CODE);
  const warnings: ValidationResult[] = [];
  const out = components.flatMap((c): EmployeeComponent[] => {
    if (!isTravel(c)) return [c];
    const km = Number(c.quantity ?? 0);
    const withinCents = prescribed == null ? 0 : Math.min(cents(c.amount), Math.round(Math.round(km * 100) * Math.round(prescribed * 100) / 100));
    const excess = (cents(c.amount) - withinCents) / 100;
    const within = withinCents / 100;
    const code = excess > 0 || otherCompensation ? TRAVEL_WITHIN_RATE_CODE : TRAVEL_NOT_TAXABLE_CODE;
    if (prescribed == null) {
      warnings.push({ code: TRAVEL_RATE_NOT_LOADED, severity: 'warning',
        message: `${c.component.name}: the prescribed rate per km for tax year ${taxYear} is not loaded, so all ${formatMoney(c.amount)} for ${km} km is taxed as remuneration (code 3722).` });
    }
    const rows: EmployeeComponent[] = [];
    if (within !== 0 || excess === 0) {
      rows.push({ ...c, amount: within, component: { ...c.component, sarsSourceCode: code, isTaxable: false, isUifApplicable: false, isSdlApplicable: false,
        name: `${c.component.name}: ${km} km within the prescribed ${formatMoney(prescribed ?? 0)} a km` } });
    }
    if (excess !== 0) {
      rows.push({ ...c, amount: excess, quantity: null, quantityUnit: null, component: { ...c.component, sarsSourceCode: TRAVEL_EXCESS_CODE,
        isTaxable: true, isUifApplicable: true, isSdlApplicable: true, name: `${c.component.name}: above the prescribed rate a km (taxed)` } });
    }
    return rows;
  });
  return { components: out, warnings };
}

/** OVERTIME_ABOVE_BCEA_THRESHOLD: overtime at a multiplier for an employee whose earnings, a year, pass the s6(3) threshold. */
export function overtimeThresholdWarnings(components: EmployeeComponent[], periodEndIso: string, periodsInYear = 12): ValidationResult[] {
  const overtime = components.filter(isOvertime);
  const threshold = bceaThresholdAt(periodEndIso);
  if (overtime.length === 0 || threshold == null) return [];
  const regular = components.filter((c) => c.component.componentType === 'earning' && !isOvertime(c) && !isTravel(c))
    .reduce((t, c) => t + c.amount, 0);
  if (regular * periodsInYear <= threshold) return [];
  return [{ code: OVERTIME_ABOVE_BCEA_THRESHOLD, severity: 'warning',
    message: `Overtime is paid at ${overtime.map((c) => `${c.rateMultiplier}x`).join(' and ')}, but this employee earns about ${formatMoney(regular * periodsInYear)} a year, `
      + `above the BCEA earnings threshold of ${formatMoney(threshold)} (s6(3) determination; figure not verified against the Gazette). `
      + 'The BCEA overtime rates do not bind above it: pay a multiplier only if the contract says so.' }];
}
