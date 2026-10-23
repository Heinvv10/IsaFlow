/** The SARS tax threshold an e@syFile employee record carries (code 4116-style age threshold). */

import { getTaxYearConfig, unloadedTaxYearMessage } from './taxTables';
import { getAge } from './payeEngine';

/** The date of birth an RSA ID number (YYMMDD...) carries; the century is the one that puts it in the past. */
function birthFromIdNumber(idNumber: unknown): Date | null {
  const m = /^(\d{2})(\d{2})(\d{2})\d{7}$/.exec(String(idNumber ?? ''));
  if (!m) return null;
  const yy = Number(m[1]);
  const year = (yy > new Date().getFullYear() % 100 ? 1900 : 2000) + yy;
  const d = new Date(year, Number(m[2]) - 1, Number(m[3]));
  return d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[3]) ? d : null;
}

/**
 * The SARS tax threshold for the year by age on its last day (G21 2027 p. 3), or
 * undefined when unknown. Age from the date of birth, else from the ID number.
 */
export function taxThresholdFor(taxYear: number, dateOfBirth: unknown, idNumber: unknown): number | undefined {
  const born = dateOfBirth ? (dateOfBirth instanceof Date ? dateOfBirth : new Date(String(dateOfBirth))) : birthFromIdNumber(idNumber);
  // February of taxYear is in taxYear: null means its tables are loaded.
  if (!born || Number.isNaN(born.getTime()) || unloadedTaxYearMessage(2, taxYear) !== null) return undefined;
  const config = getTaxYearConfig(taxYear);
  const age = getAge(born, new Date(taxYear, 2, 0));
  return age >= 75 ? config.threshold75plus : age >= 65 ? config.threshold65to74 : config.thresholdBelow65;
}
