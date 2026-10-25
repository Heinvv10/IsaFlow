/**
 * Employee facts for the e@syFile employee record, from the payroll employee
 * row (moved out of pages/api/payroll/irp5/easyfile-export.ts, 300-line cap):
 * names, dates in CCYYMMDD, periods in the year of assessment, the age on the
 * year's last day and the tax threshold that follows from it.
 */

import { getTaxYearConfig, unloadedTaxYearMessage } from './taxTables';
import { getAge } from './payeEngine';

export function firstTwoNames(fullFirst: string): string {
  return fullFirst.trim().split(/\s+/).slice(0, 2).join(' ');
}

export function initialsFromName(fullFirst: string): string {
  return fullFirst
    .trim()
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase())
    .join('')
    .slice(0, 5);
}

export function toCCYYMMDD(value: unknown): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

export function monthsBetween(start: string, endInclusive: string): number {
  // Inputs are CCYYMMDD. Count full months the employee was active within
  // the year-of-assessment window, max 12.
  const s = new Date(`${start.slice(0, 4)}-${start.slice(4, 6)}-${start.slice(6, 8)}`);
  const e = new Date(`${endInclusive.slice(0, 4)}-${endInclusive.slice(4, 6)}-${endInclusive.slice(6, 8)}`);
  const months = (e.getUTCFullYear() - s.getUTCFullYear()) * 12 + (e.getUTCMonth() - s.getUTCMonth()) + 1;
  return Math.min(12, Math.max(0, months));
}

/**
 * A calendar day as a local-midnight Date: a pg DATE arrives as 'YYYY-MM-DD' (pgTypes), which `new Date()` would
 * read as UTC midnight, a different local day west of UTC. Dates pass through; null when it does not read.
 */
export function localDay(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? ''));
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (!value) return null;
  const d = new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** CCYYMMDD of a Date's local calendar day. */
export const localCCYYMMDD = (d: Date): string =>
  `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;

/**
 * The date of birth an RSA ID number (YYMMDD...) carries: the latest century that puts it on or before today
 * (a person born in 1926 whose birthday is still ahead this year is not born in 2026); null when it is no date.
 */
export function birthFromIdNumber(idNumber: unknown, today = new Date()): Date | null {
  const m = /^(\d{2})(\d{2})(\d{2})\d{7}$/.exec(String(idNumber ?? ''));
  if (!m) return null;
  const at = (year: number) => new Date(year, Number(m[2]) - 1, Number(m[3]));
  let d = at(2000 + Number(m[1]));
  if (d > today) d = at(1900 + Number(m[1]));
  return d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[3]) ? d : null;
}

/**
 * 3080, BRS V25.3.0 p. 26: mandatory for a natural person (3020 A / B / C / M / N / R), CCYYMMDD, "must correlate
 * with the identity number (if any)" (its YYMMDD is 3060's first six digits), not after today; "must not be
 * completed" for D / E / F / G / H.
 */
export function birthDateRules(field: Map<string, string>, err: (code: string, message: string) => void): void {
  const nature = field.get('3020') ?? '';
  const dob = field.get('3080');
  if (/^[DEFGH]$/.test(nature) && dob != null) {
    err('BIRTH_3080_NOT_ALLOWED', `A certificate for nature of person ${nature} must not carry a date of birth (3080).`);
    return;
  }
  if (!/^[ABCMNR]$/.test(nature)) return;
  if (dob == null) { err('BIRTH_3080_MISSING', 'A natural person\'s certificate needs the date of birth (3080).'); return; }
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(dob);
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
  if (!m || !d || d.getMonth() !== Number(m[2]) - 1 || d.getDate() !== Number(m[3]) || d > new Date()) {
    err('BIRTH_3080_INVALID', `The date of birth (3080) must be a CCYYMMDD date not after today, not ${dob}.`);
    return;
  }
  const id = field.get('3060');
  if (id && /^\d{13}$/.test(id) && dob.slice(2) !== id.slice(0, 6)) {
    err('BIRTH_3080_NOT_ID', `The date of birth (3080, ${dob}) must correlate with the ID number (3060, ${id}).`);
  }
}

/** Age on the last day of the year of assessment; from the date of birth, else the ID number; null when unknown. */
export function ageAtYearEnd(taxYear: number, dateOfBirth: unknown, idNumber: unknown): number | null {
  const born = dateOfBirth ? localDay(dateOfBirth) : birthFromIdNumber(idNumber);
  if (!born) return null;
  return getAge(born, new Date(taxYear, 2, 0));
}

/**
 * The SARS tax threshold for the year by age on its last day (G21 2027 p. 3), or
 * undefined when unknown. Age from the date of birth, else from the ID number.
 */
export function taxThresholdFor(taxYear: number, dateOfBirth: unknown, idNumber: unknown): number | undefined {
  const age = ageAtYearEnd(taxYear, dateOfBirth, idNumber);
  // February of taxYear is in taxYear: null means its tables are loaded.
  if (age == null || unloadedTaxYearMessage(2, taxYear) !== null) return undefined;
  const config = getTaxYearConfig(taxYear);
  return age >= 75 ? config.threshold75plus : age >= 65 ? config.threshold65to74 : config.thresholdBelow65;
}
