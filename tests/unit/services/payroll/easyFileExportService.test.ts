import { describe, it, expect } from 'vitest';

import {
  UsageError,
  formatField,
  isValidPayeRef,
  isValidSdlRef,
  isValidUifRef,
  isValidTaxNumber,
  buildEmployerRecord,
  buildEmployeeRecord,
  buildTrailerRecord,
  buildIrp5File,
  buildCertificateNumber,
  type EmployerInput,
  type EmployeeInput,
} from '@/modules/accounting/services/payroll/easyFileExportService';

// ─── Reference-number regex checks ────────────────────────────────────────────

describe('reference number validators', () => {
  it.each([
    ['7123456789', true],
    ['0123456789', true],
    ['4123456789', false], // BRS — first digit must be 0/1/2/3/7/9
    ['712345678', false],
    ['71234567890', false],
  ])('PAYE %s → %s', (v, ok) => expect(isValidPayeRef(v)).toBe(ok));

  it('validates SDL (L + 9 digits)', () => {
    expect(isValidSdlRef('L123456789')).toBe(true);
    expect(isValidSdlRef('U123456789')).toBe(false);
    expect(isValidSdlRef('L12345678')).toBe(false);
  });

  it('validates UIF (U + 9 digits)', () => {
    expect(isValidUifRef('U123456789')).toBe(true);
    expect(isValidUifRef('L123456789')).toBe(false);
  });

  it('validates SARS income tax number (10 digits, first digit 0/1/2/3/9)', () => {
    expect(isValidTaxNumber('0123456789')).toBe(true);
    expect(isValidTaxNumber('4123456789')).toBe(false);
  });
});

// ─── formatField ──────────────────────────────────────────────────────────────

describe('formatField', () => {
  it('wraps alpha/AN/FT in double quotes', () => {
    expect(formatField(3030, 'Horn', 'FT')).toBe('3030,"Horn"');
    expect(formatField(2020, '7123456789', 'AN')).toBe('2020,"7123456789"');
    expect(formatField(2015, 'LIVE', 'A')).toBe('2015,"LIVE"');
  });

  it('drops cents for plain numeric fields (BRS §3j)', () => {
    expect(formatField(3601, 50000.99, 'N')).toBe('3601,50000');
  });

  it('keeps cents (N11.2) for PAYE/UIF/SDL codes', () => {
    expect(formatField(4102, 12000.5, 'N_CENTS')).toBe('4102,12000.50');
    expect(formatField(4141, 0, 'N_CENTS')).toBe('4141,0.00');
  });

  it('returns null for empty/null values (code is simply omitted)', () => {
    expect(formatField(2022, null, 'AN')).toBeNull();
    expect(formatField(2022, '', 'AN')).toBeNull();
  });

  it('rejects commas inside alpha/FT values (BRS §3h)', () => {
    expect(() => formatField(3030, 'Smith, Jones', 'FT')).toThrow(UsageError);
  });

  it('rejects pipes inside values (BRS §3h)', () => {
    expect(() => formatField(3030, 'Pipe|name', 'FT')).toThrow(UsageError);
  });

  it('rejects leading whitespace (BRS §3m)', () => {
    expect(() => formatField(3030, ' Horn', 'FT')).toThrow(UsageError);
  });

  it('rejects negative amounts (BRS §3g)', () => {
    expect(() => formatField(3601, -1, 'N')).toThrow(UsageError);
    expect(() => formatField(4102, -0.5, 'N_CENTS')).toThrow(UsageError);
  });
});

// ─── Record builders ──────────────────────────────────────────────────────────

const validEmployer: EmployerInput = {
  tradingName: 'Marneweck Holdings',
  payeReferenceNumber: '7123456789',
  sdlReferenceNumber: 'L123456789',
  uifReferenceNumber: 'U123456789',
  contactFirstName: 'Jane',
  contactSurname: 'Horn',
  contactBusinessPhone: '0118765432',
  contactCellPhone: null,
  contactEmail: 'payroll@marneweck.co.za',
  transactionYear: 2026,
  reconciliationPeriod: 202602,
  sic7Code: '69201',
  physicalStreet: '12 Main Road',
  physicalSuburb: 'Rosebank',
  physicalCity: 'Johannesburg',
  physicalPostalCode: '2196',
};

const validEmployee: EmployeeInput = {
  certificateNumber: '71234567892026020000000000000001'.slice(0, 30), // 30 chars
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
  uifEmployee4141: 177.12,
  uifEmployer4142: 177.12,
  sdl4150: 3600,
};

describe('buildEmployerRecord', () => {
  it('emits fields in BRS order ending with 9999,9999', () => {
    const lines = buildEmployerRecord(validEmployer);
    expect(lines[0]).toBe('2010,"Marneweck Holdings"');
    expect(lines[1]).toBe('2015,"LIVE"');
    expect(lines[lines.length - 1]).toBe('9999,9999');
  });

  it('omits optional null fields (e.g. 2040 cell) when empty', () => {
    const lines = buildEmployerRecord(validEmployer);
    expect(lines.some((l) => l.startsWith('2040,'))).toBe(false);
  });

  it('throws on invalid PAYE reference', () => {
    expect(() => buildEmployerRecord({ ...validEmployer, payeReferenceNumber: '123' })).toThrow(UsageError);
  });

  it('requires at least one contact phone', () => {
    expect(() => buildEmployerRecord({ ...validEmployer, contactBusinessPhone: null, contactCellPhone: null })).toThrow(UsageError);
  });

  it('rejects postal code 0000 (BRS 2080)', () => {
    expect(() => buildEmployerRecord({ ...validEmployer, physicalPostalCode: '0000' })).toThrow(UsageError);
  });

  it('rejects reconciliation period not ending in 02 or 08', () => {
    expect(() => buildEmployerRecord({ ...validEmployer, reconciliationPeriod: 202606 })).toThrow(UsageError);
  });

  it('hard-codes payroll software fields to IsaFlow', () => {
    const lines = buildEmployerRecord(validEmployer);
    expect(lines.find((l) => l.startsWith('2028,'))).toBe('2028,"IsaFlow"');
    expect(lines.find((l) => l.startsWith('2029,'))).toBe('2029,"IsaFlow Payroll"');
  });
});

describe('buildEmployeeRecord', () => {
  it('starts with 3010 certificate number and ends with 9999,9999', () => {
    const lines = buildEmployeeRecord(validEmployee);
    expect(lines[0]?.startsWith('3010,')).toBe(true);
    expect(lines[lines.length - 1]).toBe('9999,9999');
  });

  it('renders periods-in-YoA as 4-decimal field 3215', () => {
    const lines = buildEmployeeRecord(validEmployee);
    expect(lines.find((l) => l.startsWith('3215,'))).toBe('3215,12.0000');
  });

  it('formats PAYE with cents and gross without', () => {
    const lines = buildEmployeeRecord(validEmployee);
    expect(lines.find((l) => l.startsWith('3601,'))).toBe('3601,360000');
    expect(lines.find((l) => l.startsWith('4102,'))).toBe('4102,54000.00');
  });

  it('rejects non-30-char certificate numbers', () => {
    expect(() => buildEmployeeRecord({ ...validEmployee, certificateNumber: 'ABC' })).toThrow(UsageError);
  });

  it('rejects non-13-digit ID numbers', () => {
    expect(() => buildEmployeeRecord({ ...validEmployee, idNumber: '123' })).toThrow(UsageError);
  });

  it('rejects zero gross (BRS §3p — at least one income code > 0)', () => {
    expect(() => buildEmployeeRecord({ ...validEmployee, grossSalary3601: 0 })).toThrow(UsageError);
  });
});

describe('buildTrailerRecord', () => {
  it('emits 6010 record count and terminator', () => {
    expect(buildTrailerRecord(5)).toEqual(['6010,5', '9999,9999']);
  });
});

// ─── Full file ────────────────────────────────────────────────────────────────

describe('buildIrp5File', () => {
  it('emits employer + employees + trailer joined by CRLF', () => {
    const file = buildIrp5File({ employer: validEmployer, employees: [validEmployee, validEmployee] });
    const lines = file.split('\r\n');
    expect(lines[0]).toBe('2010,"Marneweck Holdings"');
    // Trailer record count = 1 employer + 2 employees = 3
    expect(lines.find((l) => l.startsWith('6010,'))).toBe('6010,3');
    expect(lines[lines.length - 1]).toBe('9999,9999');
  });

  it('throws when there are zero employees', () => {
    expect(() => buildIrp5File({ employer: validEmployer, employees: [] })).toThrow(UsageError);
  });
});

// ─── Certificate number helper ────────────────────────────────────────────────

describe('buildCertificateNumber', () => {
  it('assembles a 30-char cert number left-padded with zeros', () => {
    const n = buildCertificateNumber('7123456789', 2026, 2, '1');
    expect(n).toHaveLength(30);
    expect(n).toBe('712345678920260200000000000001');
  });

  it('strips non-alphanumerics from the unique suffix', () => {
    const n = buildCertificateNumber('7123456789', 2026, 8, 'A-1!');
    // 14-char suffix: 12 leading zeros + "A1"
    expect(n.endsWith('000000000000A1')).toBe(true);
    expect(n).toHaveLength(30);
  });

  it('rejects suffixes longer than 14 chars', () => {
    expect(() => buildCertificateNumber('7123456789', 2026, 2, 'A'.repeat(15))).toThrow(UsageError);
  });
});
