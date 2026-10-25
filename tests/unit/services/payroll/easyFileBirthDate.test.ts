/**
 * 3080, the date of birth (BRS V25.3.0 p. 26): "Mandatory if Nature of Person is A / B / C / M / N / R", CCYYMMDD,
 * "Must correlate with the identity number (if any)", "cannot be greater than the current date". Every certificate
 * IsaFlow builds is nature A with a 13-digit RSA ID (validateEmployee), so the ID number always carries a date:
 * the payroll date of birth is used when it IS the ID's date (it gives the century), else the ID's own date.
 */
import { describe, it, expect } from 'vitest';
import { buildEmployeeRecord, UsageError, type EmployeeInput } from '@/modules/accounting/services/payroll/easyFileExportService';
import { ageAtYearEnd, birthFromIdNumber, localCCYYMMDD, localDay } from '@/modules/accounting/services/payroll/easyFileEmployeeFacts';
import { birthDate3080 } from '@/modules/accounting/services/payroll/easyFileMedicalFields';
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

describe('birthFromIdNumber: the latest century on or before today', () => {
  it('this century when that is past, the last when it would be ahead', () => {
    expect(localCCYYMMDD(birthFromIdNumber('0203045009085', TODAY)!)).toBe('20020304');
    // Born 1 Dec 1926: in 2026 that birthday is still ahead, so not 2026-12-01.
    expect(localCCYYMMDD(birthFromIdNumber('2612015009087', TODAY)!)).toBe('19261201');
    expect(localCCYYMMDD(birthFromIdNumber('2610255009087', TODAY)!)).toBe('20261025');
    expect(localCCYYMMDD(birthFromIdNumber('9001015009087', TODAY)!)).toBe('19900101');
  });
  it('29 February only in a leap year; no date: null', () => {
    expect(localCCYYMMDD(birthFromIdNumber('0002295009087', TODAY)!)).toBe('20000229');
    expect(birthFromIdNumber('0102295009087', TODAY)).toBeNull();
    expect(birthFromIdNumber('9013015009087', TODAY)).toBeNull();
  });
});

describe('localDay: a pg DATE string is its own local day in any time zone', () => {
  it('YYYY-MM-DD reads as local midnight, not UTC', () => {
    const d = localDay('1961-03-01')!;
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()]).toEqual([1961, 2, 1, 0]);
    expect(ageAtYearEnd(2026, '1961-03-01', '6103015009087')).toBe(64);
    expect(ageAtYearEnd(2026, '1961-02-28', '6102285009087')).toBe(65);
  });
  it('a Date passes through; nothing or garbage is null', () => {
    const d = new Date(1990, 0, 1);
    expect(localDay(d)).toBe(d);
    expect(localDay(null)).toBeNull();
    expect(localDay('not a date')).toBeNull();
  });
});

describe('birthDate3080', () => {
  const as = (over: Partial<EmployeeInput>) => birthDate3080({ ...base, ...over }, TODAY);
  it('the payroll date of birth when it is the ID number\'s date, in its own century', () => {
    expect(as({ dateOfBirth: new Date(1990, 0, 1) })).toBe('19900101');
    expect(as({ idNumber: '2505035009081', dateOfBirth: localDay('1925-05-03') })).toBe('19250503');
  });
  it('no payroll date of birth: the ID number\'s', () => {
    expect(as({})).toBe('19900101');
    expect(as({ idNumber: '2612015009087' })).toBe('19261201');
  });
  it('a payroll date of birth that is not the ID number\'s is refused, naming both dates', () => {
    for (const dob of [new Date(1991, 0, 1), new Date(1990, 0, 2), new Date(1989, 0, 1)]) {
      expect(() => as({ dateOfBirth: dob })).toThrow(/Molefe.*payroll record \(\d{4}-\d{2}-\d{2}\) does not match the ID number \(1990-01-01\).*3080/);
    }
  });
  it('a payroll date of birth after today is refused, even on the ID\'s day', () => {
    expect(() => as({ dateOfBirth: new Date(2090, 0, 1) })).toThrow(/does not match the ID number/);
  });
  it('no payroll date of birth and the ID reads as under 15: refused, asking for the date of birth', () => {
    // 260301: 2026-03-01 (an infant) or 1926-03-01; only the payroll record can say.
    expect(() => as({ idNumber: '2603015009087' })).toThrow(/Molefe.*born 2026-03-01.*Enter the date of birth.*3080/);
    expect(as({ idNumber: '2603015009087', dateOfBirth: localDay('1926-03-01') })).toBe('19260301');
  });
  it('an ID number whose first six digits are no date is refused', () => {
    expect(() => as({ idNumber: '9013015009087' })).toThrow(/does not begin with a valid date of birth/);
    expect(() => as({ idNumber: '9013015009087', dateOfBirth: new Date(1990, 0, 13) })).toThrow(/does not begin with a valid date of birth/);
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
  it('from a 1920s payroll date of birth through the builder (not refused as a disagreement)', () => {
    expect(buildEmployeeRecord({ ...base, idNumber: '2505035009081', dateOfBirth: localDay('1925-05-03') })).toContain('3080,19250503');
  });
  it('a payroll date of birth that is not the ID\'s is refused by the builder', () => {
    expect(() => buildEmployeeRecord({ ...base, dateOfBirth: new Date(1991, 0, 1) })).toThrow(/does not match the ID number \(1990-01-01\)/);
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
  it('every natural nature (B shown) needs it; D-H must not carry it', () => {
    const as = (nature: string, ...extra: string[]) => codes(rec(...extra).map(l => (l.startsWith('3020,') ? `3020,"${nature}"` : l)));
    expect(as('B')).toContain('BIRTH_3080_MISSING');
    expect(as('R', '3080,19900101')).toEqual([]);
    expect(as('D', '3080,19900101')).toContain('BIRTH_3080_NOT_ALLOWED');
    expect(as('H')).toEqual([]);
  });
  it('a record with no nature of person is not judged on 3080', () => {
    expect(codes(rec().filter(l => !l.startsWith('3020,')))).toEqual([]);
  });
});
