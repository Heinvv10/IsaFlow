import { describe, expect, it } from 'vitest';
import {
  EMPLOYEES, buildInvalidSaId, dateOfBirth, luhnCheckDigit, luhnValid, placeholderTaxNumber, placeholderUifNumber,
} from '../../../../scripts/lib/demoReseed/employees';
import { generateDemoData } from '../../../../scripts/lib/demoReseed/generate';
import { isValidSaIdNumber } from '../../../../src/modules/accounting/services/payroll/etiEligibility';
import { inputFor } from './input';

describe('fictional employees (POPIA)', () => {
  it('has a validator that accepts a hand-built valid id', () => {
    const prefix = '880412012308';
    const valid = `${prefix}${luhnCheckDigit(prefix)}`;
    expect(luhnValid(valid)).toBe(true);
    expect(luhnValid(`${prefix}${(luhnCheckDigit(prefix) + 1) % 10}`)).toBe(false);
  });

  it('seeds 13-digit ids whose date part is the date of birth and which fail Luhn, here and in the app', () => {
    const d = generateDemoData(inputFor('2026-11-16', 7));
    expect(d.rows.payroll_employees).toHaveLength(EMPLOYEES.length);
    for (const e of d.rows.payroll_employees) {
      const id = String(e.id_number);
      const dob = String(e.date_of_birth);
      expect(id).toMatch(/^\d{13}$/);
      expect(id.slice(0, 6)).toBe(`${dob.slice(2, 4)}${dob.slice(5, 7)}${dob.slice(8, 10)}`);
      expect(Number.isNaN(Date.parse(dob))).toBe(false);
      expect(luhnValid(id)).toBe(false);
      expect(isValidSaIdNumber(id)).toBe(false);
    }
  });

  it('builds an invalid id for any date and sequence', () => {
    EMPLOYEES.forEach((e, i) => {
      const dob = dateOfBirth('2026-11-16', e, i);
      expect(luhnValid(buildInvalidSaId(dob, 100 + i))).toBe(false);
    });
  });

  it('uses placeholder tax and UIF references', () => {
    for (let i = 0; i < EMPLOYEES.length; i++) {
      expect(placeholderTaxNumber(i)).toMatch(/^000000000\d$/);
      expect(placeholderUifNumber(i)).toMatch(/^U000000\d$/);
    }
  });
});
