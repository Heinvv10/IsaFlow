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

/** The date of birth an RSA ID number (YYMMDD...) carries; the century is the one that puts it in the past. */
function birthFromIdNumber(idNumber: unknown): Date | null {
  const m = /^(\d{2})(\d{2})(\d{2})\d{7}$/.exec(String(idNumber ?? ''));
  if (!m) return null;
  const yy = Number(m[1]);
  const year = (yy > new Date().getFullYear() % 100 ? 1900 : 2000) + yy;
  const d = new Date(year, Number(m[2]) - 1, Number(m[3]));
  return d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[3]) ? d : null;
}

/** Age on the last day of the year of assessment; from the date of birth, else the ID number; null when unknown. */
export function ageAtYearEnd(taxYear: number, dateOfBirth: unknown, idNumber: unknown): number | null {
  const born = dateOfBirth ? (dateOfBirth instanceof Date ? dateOfBirth : new Date(String(dateOfBirth))) : birthFromIdNumber(idNumber);
  if (!born || Number.isNaN(born.getTime())) return null;
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
