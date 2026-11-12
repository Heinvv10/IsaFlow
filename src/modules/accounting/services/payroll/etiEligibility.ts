/**
 * ETI qualifying-employee checks the calculator can make from what is recorded (wave 5 ET review round 2, Hein ruling
 * on adv M4). ETI Act s6(b): the employee is in possession of an identity card (Identification Act s14), an asylum
 * seeker permit (Refugees Act s22(1)) or a refugee identity document (Refugees Act s30) (SARS Guide to the Employment
 * Tax Incentive, Issue 5, §3.2.2 p. 25). Possession is shown by a valid South African ID number, or by the employee's
 * recorded document (migration 976). s6(c) connected persons and s6(d) domestic workers are not captured: the line
 * carries an approval warning instead (payrollLineEti), named in payroll/.claude.md.
 */
import type { PayrollEmployee } from './payrollTypes';

/** A 13-digit South African ID number with a real date of birth (YYMMDD, either century) and a valid Luhn check digit. */
export function isValidSaIdNumber(raw: string | null | undefined): boolean {
  const id = (raw ?? '').replace(/\s+/g, '');
  if (!/^\d{13}$/.test(id)) return false;
  const yy = Number(id.slice(0, 2));
  const mm = Number(id.slice(2, 4));
  const dd = Number(id.slice(4, 6));
  const real = [1900 + yy, 2000 + yy].some((y) => {
    const d = new Date(Date.UTC(y, mm - 1, dd));
    return d.getUTCFullYear() === y && d.getUTCMonth() === mm - 1 && d.getUTCDate() === dd;
  });
  if (!real) return false;
  let sum = 0;
  for (let i = 0; i < 13; i += 1) {
    let d = Number(id[12 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/**
 * Review round 3 (adv3 L1): a valid SA ID number whose YYMMDD is not the recorded date of birth. One of the two is
 * wrong, and ETI turns on the age (s6(a)): refused, with a warning naming both. False when either is missing.
 */
export function idDateOfBirthMismatch(e: Pick<PayrollEmployee, 'idNumber' | 'dateOfBirth'>): boolean {
  const id = (e.idNumber ?? '').replace(/\s+/g, '');
  if (!e.dateOfBirth || !isValidSaIdNumber(id)) return false;
  const d = e.dateOfBirth;
  const yymmdd = `${String(d.getFullYear() % 100).padStart(2, '0')}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  return id.slice(0, 6) !== yymmdd;
}

/** s6(b): a permit or refugee identity document recorded, else a valid SA ID number. */
export function etiIdDocumentShown(e: Pick<PayrollEmployee, 'idNumber' | 'etiIdDocument'>): boolean {
  if (e.etiIdDocument === 'asylum_seeker_permit' || e.etiIdDocument === 'refugee_id') return true;
  return isValidSaIdNumber(e.idNumber);
}
