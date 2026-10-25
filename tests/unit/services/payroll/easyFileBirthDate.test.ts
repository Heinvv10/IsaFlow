/**
 * 3080, the date of birth (BRS V25.3.0 p. 26): "Mandatory if Nature of Person is A / B / C / M / N / R", CCYYMMDD,
 * "Must correlate with the identity number (if any)", "cannot be greater than the current date". Every certificate
 * IsaFlow builds is nature A with a 13-digit RSA ID (validateEmployee), so the ID number always carries a date:
 * the payroll date of birth is used when it IS the ID's date (it gives the century), else the ID's own date.
 */
import { describe, it, expect } from 'vitest';
import { buildEmployeeRecord, UsageError, type EmployeeInput } from '@/modules/accounting/services/payroll/easyFileExportService';
import { certificateBirthDate } from '@/modules/accounting/services/payroll/easyFileEmployeeFacts';
import { validateCertificateTaxFields } from '@/modules/accounting/services/payroll/irp5ValidationEngine';

const base: EmployeeInput = {
  certificateNumber: '712345678920260200000000000001',
  yearOfAssessment: 2026,
  surname: 'Molefe',
  firstNames: 'Thandi Mbali',
  initials: 'TM',
  idNumber: '9001015009087',
  taxNumber: '0123456789',
  employmentStartDate: '20250301',
  employmentEndDate: null,
  periodsInYoA: 12,
  grossSalary3601: 360000,
  paye4102: 54000,
  uifEmployee: 177.12,
  uifEmployer: 177.12,
  sdl4142: 3600,
};
const TODAY = new Date(2026, 9, 25);

describe('certificateBirthDate', () => {
  it('the payroll date of birth when it is the ID number\'s date', () => {
    expect(certificateBirthDate(new Date(1990, 0, 1), '9001015009087', TODAY)).toBe('19900101');
    // The record gives the century the ID number cannot: born 1925, not 2025.
    expect(certificateBirthDate(new Date(1925, 4, 3), '2505035009081', TODAY)).toBe('19250503');
  });
  it('a pg DATE string (UTC midnight) reads as its own day', () => {
    expect(certificateBirthDate(new Date('1990-01-01'), '9001015009087', TODAY)).toBe('19900101');
  });
  it('no payroll date of birth: the ID number\'s', () => {
    expect(certificateBirthDate(null, '9001015009087', TODAY)).toBe('19900101');
    expect(certificateBirthDate(undefined, '0203045009085', TODAY)).toBe('20020304');
  });
  it('a payroll date of birth that is not the ID number\'s: the ID number\'s (3080 must correlate with 3060)', () => {
    expect(certificateBirthDate(new Date(1991, 0, 1), '9001015009087', TODAY)).toBe('19900101');
    expect(certificateBirthDate(new Date(1990, 0, 2), '9001015009087', TODAY)).toBe('19900101');
  });
  it('a payroll date of birth after today, even on the ID\'s day and month: the ID number\'s', () => {
    expect(certificateBirthDate(new Date(2090, 0, 1), '9001015009087', TODAY)).toBe('19900101');
  });
  it('an ID number whose first six digits are no date: null', () => {
    expect(certificateBirthDate(null, '9013015009087', TODAY)).toBeNull();
    expect(certificateBirthDate(new Date(1990, 12, 1), '9013015009087', TODAY)).toBeNull();
  });
});

describe('buildEmployeeRecord emits 3080', () => {
  it('right after 3060, CCYYMMDD, unquoted', () => {
    const record = buildEmployeeRecord(base);
    const at = record.indexOf('3060,9001015009087');
    expect(at).toBeGreaterThan(-1);
    expect(record[at + 1]).toBe('3080,19900101');
    expect(validateCertificateTaxFields(record)).toEqual([]);
  });
  it('from the payroll date of birth when it matches the ID', () => {
    expect(buildEmployeeRecord({ ...base, dateOfBirth: new Date(1990, 0, 1) })).toContain('3080,19900101');
  });
  it('an ID number that carries no date is refused, naming 3080', () => {
    const run = () => buildEmployeeRecord({ ...base, idNumber: '9013015009087' });
    expect(run).toThrow(UsageError);
    expect(run).toThrow(/Molefe.*does not begin with a valid date of birth.*3080/);
  });
});

describe('validateCertificateTaxFields: 3080 (BRS V25.3.0 p. 26)', () => {
  const rec = (...extra: string[]) => ['3015,"IRP5"', '3020,"A"', '3025,2027', '3060,9001015009087', '3601,60000', '4102,10.00', ...extra];
  const codes = (lines: string[]) => validateCertificateTaxFields(lines).map(m => m.code);
  it('a nature-A certificate without 3080 is refused', () => {
    expect(codes(rec())).toContain('BIRTH_3080_MISSING');
  });
  it('3080 that is no CCYYMMDD date, or after today, is refused', () => {
    expect(codes(rec('3080,1990011'))).toContain('BIRTH_3080_INVALID');
    expect(codes(rec('3080,19900231'))).toContain('BIRTH_3080_INVALID');
    expect(codes(rec('3080,29900101'))).toContain('BIRTH_3080_INVALID');
  });
  it('3080 that is not the ID number\'s date is refused', () => {
    expect(codes(rec('3080,19910101'))).toContain('BIRTH_3080_NOT_ID');
    expect(codes(rec('3080,19900102'))).toContain('BIRTH_3080_NOT_ID');
  });
  it('3080 on the ID number\'s date passes', () => {
    expect(codes(rec('3080,19900101'))).toEqual([]);
  });
  it('a record with no nature of person is not judged on 3080', () => {
    expect(codes(rec().filter(l => !l.startsWith('3020,')))).toEqual([]);
  });
});
