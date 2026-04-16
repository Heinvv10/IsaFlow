/**
 * Payroll Validation Service
 * SA ID number (Luhn + dob + gender), tax number, and duplicate detection.
 * All validators return a typed result — never throw for validation failures.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';

export type ValidationResult =
  | { valid: true }
  | { valid: false; reason: string };

export function validateSaIdNumber(id: string): ValidationResult {
  if (!id) return { valid: false, reason: 'ID number is required' };
  const digits = id.trim();
  if (digits.length !== 13) return { valid: false, reason: 'ID number must be 13 digits' };
  if (!/^\d{13}$/.test(digits)) return { valid: false, reason: 'ID number must be numeric' };

  const yy = parseInt(digits.substring(0, 2), 10);
  const mm = parseInt(digits.substring(2, 4), 10);
  const dd = parseInt(digits.substring(4, 6), 10);
  if (mm < 1 || mm > 12) return { valid: false, reason: 'Invalid date of birth — month' };
  if (dd < 1 || dd > 31) return { valid: false, reason: 'Invalid date of birth — day' };

  const year = yy <= 29 ? 2000 + yy : 1900 + yy;
  const dob = new Date(year, mm - 1, dd);
  if (
    dob.getFullYear() !== year ||
    dob.getMonth() !== mm - 1 ||
    dob.getDate() !== dd
  ) {
    return { valid: false, reason: 'Invalid date of birth' };
  }

  if (!luhnCheck(digits)) return { valid: false, reason: 'ID number checksum invalid' };
  return { valid: true };
}

function luhnCheck(digits: string): boolean {
  let sum = 0;
  let alternate = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = parseInt(digits[i]!, 10);
    if (alternate) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alternate = !alternate;
  }
  return sum % 10 === 0;
}

export function extractDateOfBirthFromId(id: string): string | null {
  if (!/^\d{13}$/.test(id)) return null;
  const yy = parseInt(id.substring(0, 2), 10);
  const mm = id.substring(2, 4);
  const dd = id.substring(4, 6);
  const year = yy <= 29 ? 2000 + yy : 1900 + yy;
  return `${year}-${mm}-${dd}`;
}

export function extractGenderFromId(id: string): 'male' | 'female' | null {
  if (!/^\d{13}$/.test(id)) return null;
  const digit = parseInt(id[6]!, 10);
  return digit >= 5 ? 'male' : 'female';
}

export function validateSaTaxNumber(taxNumber: string): ValidationResult {
  if (!taxNumber) return { valid: false, reason: 'Tax number is required' };
  const digits = taxNumber.trim();
  if (!/^\d{10}$/.test(digits)) {
    return { valid: false, reason: 'Tax number must be 10 numeric digits' };
  }
  if (digits.startsWith('0')) {
    return { valid: false, reason: 'Tax number cannot start with zero' };
  }
  return { valid: true };
}

export async function isDuplicateIdNumber(
  companyId: string,
  idNumber: string,
  excludeEmployeeId?: string
): Promise<boolean> {
  try {
    const rows = excludeEmployeeId
      ? (await sql`
          SELECT 1 FROM employees
          WHERE company_id = ${companyId}::UUID
            AND id_number = ${idNumber}
            AND id != ${excludeEmployeeId}::UUID
          LIMIT 1
        `) as unknown[]
      : (await sql`
          SELECT 1 FROM employees
          WHERE company_id = ${companyId}::UUID
            AND id_number = ${idNumber}
          LIMIT 1
        `) as unknown[];
    return rows.length > 0;
  } catch (err) {
    log.error('isDuplicateIdNumber failed', { error: err }, 'payroll-validation');
    throw err;
  }
}
