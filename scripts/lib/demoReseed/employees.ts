/**
 * Fictional employees (POPIA): invented names, SA ID numbers that deliberately
 * FAIL the Luhn check, tax numbers 0000000001.. and UIF references U0000001..
 * so no seeded identifier can belong to a real person.
 *
 * The ID's date part is a real date matching date_of_birth (the payroll engine
 * reads the age from it); only the check digit is wrong. Every employee
 * therefore fails `isValidSaIdNumber`, so no ETI is ever calculated for them.
 */

import { addMonths } from './dates';

export interface EmployeeFixture {
  id: string;
  number: string;
  firstName: string;
  lastName: string;
  gender: 'male' | 'female';
  /** Age in whole years at the run date. */
  age: number;
  /** Basic salary per month, rand. */
  salary: number;
  occupation: string;
  department: string;
  /** Months before the window start (positive) or into the window (negative) that they started. */
  startOffsetMonths: number;
  areaCode: string;
}

export const EMPLOYEES: readonly EmployeeFixture[] = [
  { id: 'e1000000-0000-0000-0000-000000000001', number: 'EMP001', firstName: 'Thandeka', lastName: 'Mokoena-Vos', gender: 'female', age: 41, salary: 62000, occupation: 'Operations manager', department: 'Management', startOffsetMonths: 30, areaCode: '011' },
  { id: 'e1000000-0000-0000-0000-000000000002', number: 'EMP002', firstName: 'Pieter Lourens', lastName: 'Adendorff', gender: 'male', age: 36, salary: 44500, occupation: 'Senior network technician', department: 'Installations', startOffsetMonths: 26, areaCode: '012' },
  { id: 'e1000000-0000-0000-0000-000000000003', number: 'EMP003', firstName: 'Naledi', lastName: 'Sekwati-Hall', gender: 'female', age: 29, salary: 27500, occupation: 'Bookkeeper', department: 'Finance', startOffsetMonths: 14, areaCode: '011' },
  { id: 'e1000000-0000-0000-0000-000000000004', number: 'EMP004', firstName: 'Riaan', lastName: 'du Plooy-Mabena', gender: 'male', age: 33, salary: 31000, occupation: 'Network technician', department: 'Installations', startOffsetMonths: 4, areaCode: '016' },
  { id: 'e1000000-0000-0000-0000-000000000005', number: 'EMP005', firstName: 'Ayesha', lastName: 'Karodia-Smit', gender: 'female', age: 47, salary: 38500, occupation: 'Sales and accounts lead', department: 'Sales', startOffsetMonths: -6, areaCode: '031' },
  { id: 'e1000000-0000-0000-0000-000000000006', number: 'EMP006', firstName: 'Sibusiso', lastName: 'Mahlobo-Grey', gender: 'male', age: 26, salary: 18500, occupation: 'Installation assistant', department: 'Installations', startOffsetMonths: -11, areaCode: '021' },
];

/** The standard Luhn check over all 13 digits. */
export function luhnValid(id: string): boolean {
  if (!/^\d{13}$/.test(id)) return false;
  let sum = 0;
  for (let i = 0; i < 13; i++) {
    let d = Number(id[12 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/** The check digit that makes a 12-digit prefix Luhn-valid. */
export function luhnCheckDigit(prefix12: string): number {
  for (let z = 0; z <= 9; z++) if (luhnValid(`${prefix12}${z}`)) return z;
  throw new Error(`no check digit for ${prefix12}`);
}

/**
 * YYMMDD + SSSS + C (0, citizen) + A (8) + Z, where Z is the correct check
 * digit plus one modulo 10: the number ALWAYS fails the Luhn check.
 */
export function buildInvalidSaId(dob: string, sequence: number): string {
  const yymmdd = `${dob.slice(2, 4)}${dob.slice(5, 7)}${dob.slice(8, 10)}`;
  const prefix = `${yymmdd}${String(sequence).padStart(4, '0')}08`;
  return `${prefix}${(luhnCheckDigit(prefix) + 1) % 10}`;
}

/** Placeholder SARS tax number: ten digits, `000000000N`. */
export function placeholderTaxNumber(index: number): string {
  return String(index + 1).padStart(10, '0');
}

export function placeholderUifNumber(index: number): string {
  return `U${String(index + 1).padStart(7, '0')}`;
}

/** Date of birth: `age` years before the run date's year, month and day from the index (always a real date). */
export function dateOfBirth(today: string, e: EmployeeFixture, index: number): string {
  const year = Number(today.slice(0, 4)) - e.age - 1;
  const month = ((index * 5) % 12) + 1;
  const day = ((index * 7) % 27) + 1;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Start date: the first of a month `startOffsetMonths` before the window start. */
export function startDate(windowStart: string, e: EmployeeFixture): string {
  const s = addMonths(Number(windowStart.slice(0, 4)), Number(windowStart.slice(5, 7)), -e.startOffsetMonths);
  return `${s.year}-${String(s.month).padStart(2, '0')}-01`;
}
