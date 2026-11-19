/**
 * The e@syFile certificate record's identity and period codes, each pinned to its row in the SARS BRS PAYE Employer
 * Reconciliation V25.3.0 (Jun-26; the same codes in V22.1.2 and V23.0.0). Before wave 6 EZF the writer put the income
 * tax reference under 3150 (the work address postal code, p. 30), the employment dates under 3200 / 3210 (pay periods
 * in the year / worked, p. 33) and the months worked under 3215 (residential suburb, p. 35).
 */
import { describe, expect, it } from 'vitest';
import { buildEmployeeRecord, buildEmployerRecord, formatField, UsageError, type EmployeeInput, type EmployerInput } from '@/modules/accounting/services/payroll/easyFileExportService';
import { CERTIFICATE_FIELDS, UNWRITTEN_MANDATORY_CODES } from '@/modules/accounting/services/payroll/easyFileCertificateCodes';
import { monthlyPayPeriodsWorked } from '@/modules/accounting/services/payroll/easyFileEmployeeFacts';
import { currentCertificate } from '@/modules/accounting/services/payroll/easyFileLegacyCertificate';

const employer: EmployerInput = {
  tradingName: 'Marneweck Holdings', payeReferenceNumber: '7123456789', sdlReferenceNumber: null, uifReferenceNumber: null,
  contactFirstName: 'Jane', contactSurname: 'Horn', contactBusinessPhone: '0118765432', contactCellPhone: null, contactEmail: null,
  transactionYear: 2026, reconciliationPeriod: 202602, sic7Code: '69201', physicalStreet: '12 Main Road', physicalSuburb: null,
  physicalCity: 'Johannesburg', physicalPostalCode: '2196',
};

const employee: EmployeeInput = {
  certificateNumber: '712345678920260200000000000001', yearOfAssessment: 2026, surname: 'Molefe', firstNames: 'Thandi',
  initials: 'T', idNumber: '0001015009087', taxNumber: '0123456789',
  taxPeriodStart: '20250615', taxPeriodEnd: '20260228', payPeriodsInYear: 12, payPeriodsWorked: 8.5333,
  grossSalary3601: 240_000, paye4102: 18_000, uifEmployee: 1_000, uifEmployer: 1_000, sdl4142: 2_400,
};

const field = (lines: string[], code: number): string | undefined => lines.find((l) => l.startsWith(`${code},`));

describe('the BRS code of each identity and period field (BRS V25.3.0)', () => {
  // [field, code, BRS page] — the table in the PR body.
  it.each([
    ['incomeTaxReference', 3100, 26], ['taxPeriodStart', 3170, 32], ['taxPeriodEnd', 3180, 32],
    ['payPeriodsInYear', 3200, 33], ['payPeriodsWorked', 3210, 33], ['identityNumber', 3060, 20], ['dateOfBirth', 3080, 26],
  ] as const)('%s is code %i (p. %i)', (name, code, page) => {
    expect(CERTIFICATE_FIELDS[name]).toMatchObject({ code, brsPage: page });
  });

  it('writes the tax reference under 3100 (N10, unquoted), the tax period under 3170 / 3180, the pay periods under 3200 / 3210 (N3.4)', () => {
    const lines = buildEmployeeRecord(employee);
    expect(field(lines, 3100)).toBe('3100,0123456789');
    expect(field(lines, 3170)).toBe('3170,20250615');
    expect(field(lines, 3180)).toBe('3180,20260228');
    expect(field(lines, 3200)).toBe('3200,12.0000');
    expect(field(lines, 3210)).toBe('3210,8.5333');
  });

  it('writes none of 3150 (work postal code), 3215 (residential suburb) or any other field it holds no data for', () => {
    const lines = buildEmployeeRecord(employee);
    for (const code of UNWRITTEN_MANDATORY_CODES) expect(field(lines, code), String(code)).toBeUndefined();
  });

  it('keeps the ID number\'s leading zero (N13; born 2000-2009)', () => {
    expect(field(buildEmployeeRecord(employee), 3060)).toBe('3060,0001015009087');
  });

  it('the fields stand in code order: 3080, 3100, 3170, 3180, 3200, 3210', () => {
    const codes = buildEmployeeRecord(employee).map((l) => Number(l.split(',')[0]));
    const order = [3080, 3100, 3170, 3180, 3200, 3210].map((c) => codes.indexOf(c));
    expect(order.every((at, i) => at > (i === 0 ? -1 : order[i - 1]!))).toBe(true);
  });

  it('a lump sum as the only income: 3200 and 3210 are 1.0000 (p. 33-34)', () => {
    const lines = buildEmployeeRecord({
      ...employee, grossSalary3601: 0, paye4102: 0,
      lumpSums: [{ sourceCode: '3901', directiveNumber: '123456789', directiveIssuedDate: '20250701', amount: 50_000, paye: 9_000 }],
    });
    expect([field(lines, 3200), field(lines, 3210)]).toEqual(['3200,1.0000', '3210,1.0000']);
  });

  it('employer PAYE reference 2020 is N10 (p. 10): unquoted', () => {
    expect(field(buildEmployerRecord(employer), 2020)).toBe('2020,7123456789');
  });
});

describe('3100 rules (BRS V25.3.0 p. 26-27)', () => {
  it('mandatory on an IRP5 with PAYE: refused without it, naming the employee and the code', () => {
    expect(() => buildEmployeeRecord({ ...employee, taxNumber: null })).toThrow(/Molefe.*code 3100/);
  });

  it('optional on an IT3(a) with reason 02: written without it', () => {
    const lines = buildEmployeeRecord({ ...employee, taxNumber: null, grossSalary3601: 50_000, paye4102: 0, taxThreshold: 95_750 });
    expect(field(lines, 4150)).toBe('4150,02');
    expect(field(lines, 3100)).toBeUndefined();
  });

  it('mandatory on an IT3(a) whose reason is not 02 or 04 (03: a contractor)', () => {
    expect(() => buildEmployeeRecord({ ...employee, taxNumber: null, grossSalary3601: 0, paye4102: 0, independentContractor3616: 10_000 }))
      .toThrow(/code 3100.*reason is 03/);
  });

  it('nature A: starts with 0, 1, 2 or 3 (9 is a company\'s)', () => {
    expect(() => buildEmployeeRecord({ ...employee, taxNumber: '9123456789' })).toThrow(UsageError);
  });
});

describe('3170 / 3180 / 3210 rules (BRS V25.3.0 p. 32-33)', () => {
  it('3170 after 3180 is refused', () => {
    expect(() => buildEmployeeRecord({ ...employee, taxPeriodStart: '20260101', taxPeriodEnd: '20251231' })).toThrow(/code 3170/);
  });

  it('3170 before 1 January of the year before the year of assessment is refused', () => {
    expect(() => buildEmployeeRecord({ ...employee, taxPeriodStart: '20241231' })).toThrow(/code 3170.*1 January 2025/);
  });

  it('3210 above 3200 is refused', () => {
    expect(() => buildEmployeeRecord({ ...employee, payPeriodsWorked: 12.5 })).toThrow(/code 3210/);
  });
});

describe('monthlyPayPeriodsWorked: whole months 1, a part month its fraction of calendar days', () => {
  it.each([
    ['20250301', '20260228', 12],
    ['20250301', '20250831', 6],
    ['20250615', '20260228', 8 + 16 / 30],        // 16 of June's 30 days, then July to February
    ['20250301', '20250310', 10 / 31],
    ['20240301', '20250228', 12],                  // a leap year's February is still one period
    ['20250201', '20250214', 14 / 28],
  ])('%s to %s = %f', (start, end, expected) => {
    expect(monthlyPayPeriodsWorked(start, end)).toBe(Math.round(expected * 10000) / 10000);
  });
});

describe('a certificate stored before the fix (an EMP501 version finalised earlier) is read in today\'s shape', () => {
  it('derives the tax period from the stored employment dates and the version\'s period', () => {
    const legacy = { surname: 'Molefe', employmentStartDate: '20200101', employmentEndDate: '20251015', periodsInYoA: 8 };
    expect(currentCertificate(legacy, 2026, 'annual')).toEqual({
      surname: 'Molefe', taxPeriodStart: '20250301', taxPeriodEnd: '20251015', payPeriodsInYear: 12,
      payPeriodsWorked: monthlyPayPeriodsWorked('20250301', '20251015'),
    });
  });

  it('an interim certificate with no leaving date ends on 31 August', () => {
    const legacy = { employmentStartDate: '20250401', employmentEndDate: null, periodsInYoA: 5 };
    expect(currentCertificate(legacy, 2026, 'interim')).toMatchObject({ taxPeriodStart: '20250401', taxPeriodEnd: '20250831', payPeriodsWorked: 5 });
  });

  it('a certificate already in today\'s shape is returned as it is', () => {
    expect(currentCertificate(employee, 2026, 'annual')).toBe(employee);
  });
});

describe('formatField refuses delimiter and control characters in A / AN / FT values (BRS V25.3.0 p. 5, §3(h)(l) p. 8)', () => {
  it.each([
    ['a comma', 'Molefe, T'], ['a pipe', 'Molefe|T'], ['a double quote', 'Mole"fe'], ['CR', 'Molefe\r3601,1'],
    ['LF', 'Molefe\n9999,9999'], ['a tab', 'Mole\tfe'], ['NUL', 'Mole\u0000fe'], ['DEL', 'Mole\u007ffe'],
  ])('%s is refused, naming the field, for every quoted type', (_what, value) => {
    for (const type of ['A', 'AN', 'FT'] as const) expect(() => formatField(3030, value, type)).toThrow(/Field 3030 contains/);
  });

  it('the refusal names the character and never echoes a raw control character', () => {
    expect(() => formatField(3030, 'Mole\nfe', 'FT')).toThrow(/control character \(U\+000A\).*"Mole\?fe"/);
  });

  it('Free Text characters the BRS lists are kept as they are', () => {
    expect(formatField(3030, "O'Brien-Smith & Co (Pty) Ltd. #1 ê/ë @ $!?=;:_+\\", 'FT')).toBe(`3030,"O'Brien-Smith & Co (Pty) Ltd. #1 ê/ë @ $!?=;:_+\\"`);
  });

  it('a surname carrying a line break cannot add a record: buildEmployeeRecord refuses the certificate', () => {
    expect(() => buildEmployeeRecord({ ...employee, surname: 'Molefe"\r\n3601,999999\r\n3030,"X' })).toThrow(UsageError);
  });

  it('an employer trading name carrying a line break is refused too', () => {
    expect(() => buildEmployerRecord({ ...employer, tradingName: 'Acme\r\n2015,"TEST' })).toThrow(/Field 2010 contains/);
  });
});
