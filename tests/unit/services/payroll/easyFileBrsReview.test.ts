/**
 * Wave 6 EZF review round 1 (#1688): the leaver paid after leaving (H1), versions finalised before the fix (M1, M2),
 * the file-kind bump (M4), the 3100 zeros (L1), N3.4's bound and 3180's "today plus 30 days" (L3). SARS BRS PAYE
 * Employer Reconciliation V25.3.0.
 */
import { describe, expect, it } from 'vitest';
import { buildEmployeeRecord, buildIrp5File, type EmployeeInput, type EmployerInput } from '@/modules/accounting/services/payroll/easyFileExportService';
import { certificateTaxPeriod } from '@/modules/accounting/services/payroll/easyFileEmployeeFacts';
import { currentCertificate, currentEmployer, isLegacyLayout } from '@/modules/accounting/services/payroll/easyFileLegacyCertificate';
import { emp501FileOf } from '@/modules/accounting/services/returns/emp501FilingFile';
import { EMP501_EASYFILE_KIND, emp501LayoutNote } from '@/modules/accounting/services/returns/emp501FileLayout';
import { FILING_FILE_KIND } from '@/modules/accounting/services/returns/filingFileContent';
import { ReturnRefusal } from '@/modules/accounting/services/returns/returnVersionTypes';

const employer: EmployerInput = {
  tradingName: 'Marneweck Holdings', payeReferenceNumber: '7123456789', sdlReferenceNumber: null, uifReferenceNumber: null,
  contactFirstName: 'Jane', contactSurname: 'Horn', contactBusinessPhone: '0118765432', contactCellPhone: null, contactEmail: null,
  transactionYear: 2026, reconciliationPeriod: 202602, sic7Code: '69201', physicalStreet: '12 Main Road', physicalSuburb: null,
  physicalCity: 'Johannesburg', physicalPostalCode: '2196',
};
const employee: EmployeeInput = {
  certificateNumber: '712345678920260200000000000001', yearOfAssessment: 2026, surname: 'Molefe', firstNames: 'Thandi',
  initials: 'T', idNumber: '9001015009087', taxNumber: '0123456789',
  taxPeriodStart: '20250301', taxPeriodEnd: '20260228', payPeriodsInYear: 12, payPeriodsWorked: 12,
  grossSalary3601: 240_000, paye4102: 18_000, uifEmployee: 1_000, uifEmployer: 1_000, sdl4142: 2_400,
};
const AFTER_YEAR = new Date(2026, 3, 15); // 15 April 2026: the 2026 file can be built
const legacyOf = (e: EmployeeInput, start: string, end: string | null) => {
  const { taxPeriodStart: _s, taxPeriodEnd: _e, payPeriodsInYear: _y, payPeriodsWorked: _w, ...rest } = e;
  return { ...rest, employmentStartDate: start, employmentEndDate: end, periodsInYoA: 12 };
};

describe('H1: the certificate tax period of a leaver paid after leaving (BRS p. 32: 3170 <= 3180)', () => {
  const Y = { first: '20260301', last: '20270228' };

  it('employment inside the period: the period cut to it', () => {
    expect(certificateTaxPeriod({ ...Y, employmentStart: '20200101', employmentEnd: '20261015' })).toEqual({ start: '20260301', end: '20261015' });
  });

  it('left before the period, paid in it: the first and last payment dates', () => {
    expect(certificateTaxPeriod({ ...Y, employmentStart: '2020-01-01'.replaceAll('-', ''), employmentEnd: '20260131', firstPaid: '20260410', lastPaid: '20260630' }))
      .toEqual({ start: '20260410', end: '20260630' });
  });

  it('payment dates outside the period are clamped to it', () => {
    expect(certificateTaxPeriod({ ...Y, employmentStart: null, employmentEnd: '20250131', firstPaid: '20250201', lastPaid: '20270331' }))
      .toEqual({ start: '20260301', end: '20270228' });
  });

  it('left before the period and no payment date known: null, never start > end', () => {
    expect(certificateTaxPeriod({ ...Y, employmentStart: '20200101', employmentEnd: '20260131' })).toBeNull();
  });

  it('a legacy certificate of such a leaver is refused by name, asking for an amend (no payment date was stored)', () => {
    expect(() => currentCertificate(legacyOf(employee, '20200101', '20250131'), 2026, 'annual'))
      .toThrow(/Molefe \(certificate 712345678920260200000000000001\).*Amend the return and finalise it again/);
  });
});

describe('every certificate refusal names the employee', () => {
  it('a validation error (3170 after 3180) carries the surname and certificate number', () => {
    expect(() => buildEmployeeRecord({ ...employee, taxPeriodStart: '20260101', taxPeriodEnd: '20251231' }, AFTER_YEAR))
      .toThrow(/^Molefe \(certificate 712345678920260200000000000001\): .*code 3170/);
  });

  it('a field-format error (a control character) carries them too', () => {
    expect(() => buildEmployeeRecord({ ...employee, firstNames: 'Thandi\n' }, AFTER_YEAR)).toThrow(/^Molefe \(certificate 7123/);
  });
});

describe('M1 / M2: an EMP501 version finalised before the fix', () => {
  const legacyFigures = (over: Partial<EmployeeInput> = {}) => ({
    taxYear: 2026, kind: 'annual', employer: { ...employer, physicalSuburb: 'Gauteng' },
    employees: [legacyOf({ ...employee, ...over }, '20200101', null)],
  });

  it('is recognised by its stored certificates', () => {
    expect(isLegacyLayout(legacyFigures().employees)).toBe(true);
    expect(isLegacyLayout([employee])).toBe(false);
  });

  it('its employer record loses the province stored under 2065; a current one is unchanged', () => {
    expect(currentEmployer({ ...employer, physicalSuburb: 'Gauteng' }, true).physicalSuburb).toBeNull();
    expect(currentEmployer({ ...employer, physicalSuburb: 'Rosebank' }, false).physicalSuburb).toBe('Rosebank');
  });

  it('its file is rebuilt with the BRS codes and no province', () => {
    const lines = emp501FileOf({ formType: 'EMP501', figures: legacyFigures() }).body.split('\r\n');
    expect(lines).toEqual(expect.arrayContaining(['3100,0123456789', '3170,20250301', '3180,20260228', '3200,12.0000', '3210,12.0000']));
    expect(lines.some((l) => l.startsWith('2065,') || l.startsWith('3150,') || l.startsWith('3215,'))).toBe(false);
  });

  it('a rebuild that breaks a BRS rule (no tax number under PAYE) is refused 409, naming the employee and the way out', () => {
    let err: unknown;
    try { emp501FileOf({ formType: 'EMP501', figures: legacyFigures({ taxNumber: null }) }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(ReturnRefusal);
    expect((err as ReturnRefusal).message).toMatch(/finalised before the e@syFile code fix.*Molefe.*code 3100.*amend the return and finalise it again/);
  });

  it('a 9-prefixed tax number on nature A is refused the same way', () => {
    expect(() => emp501FileOf({ formType: 'EMP501', figures: legacyFigures({ taxNumber: '9123456789' }) })).toThrow(/finalised before the e@syFile code fix.*Molefe/);
  });
});

describe('M4: the EMP501 file kind names the layout', () => {
  it('is emp501_easyfile@2, which 999v\'s CHECK (^emp501_easyfile@[1-9][0-9]{0,3}$) admits', () => {
    expect(FILING_FILE_KIND.EMP501).toBe('emp501_easyfile@2');
    expect(EMP501_EASYFILE_KIND).toMatch(/^emp501_easyfile@[1-9][0-9]{0,3}$/);
  });

  it('a version stamped @1 and not filed is told its file is rebuilt and to amend before filing', () => {
    expect(emp501LayoutNote({ formType: 'EMP501', status: 'finalised', filingFileKind: 'emp501_easyfile@1' })).toMatch(/rebuilt in the current layout.*amend/);
  });

  it('a FILED @1 version is told its stored file is kept as the record', () => {
    expect(emp501LayoutNote({ formType: 'EMP501', status: 'filed', filingFileKind: 'emp501_easyfile@1' })).toMatch(/kept as the record/);
  });

  it('nothing to say for a current stamp, no stamp, or another form', () => {
    expect(emp501LayoutNote({ formType: 'EMP501', status: 'finalised', filingFileKind: 'emp501_easyfile@2' })).toBeNull();
    expect(emp501LayoutNote({ formType: 'EMP501', status: 'finalised', filingFileKind: null })).toBeNull();
    expect(emp501LayoutNote({ formType: 'EMP201', status: 'filed', filingFileKind: 'emp201_capture_csv@1' })).toBeNull();
  });
});

describe('L1 / L3', () => {
  it('3100 made only of zeros is refused (p. 27)', () => {
    expect(() => buildEmployeeRecord({ ...employee, taxNumber: '0000000000' }, AFTER_YEAR)).toThrow(/code 3100.*only zeros/);
  });

  it('N3.4 is at most 999.9999 (p. 33)', () => {
    expect(() => buildEmployeeRecord({ ...employee, payPeriodsInYear: 1000, payPeriodsWorked: 12 }, AFTER_YEAR)).toThrow(/code 3200.*999\.9999/);
  });

  it('3180 more than 30 days after today is refused (p. 32), naming the first day it can be filed', () => {
    expect(() => buildEmployeeRecord(employee, new Date(2026, 0, 28))).toThrow(/code 3180.*filed from 2026-01-29/);
    expect(buildEmployeeRecord(employee, new Date(2026, 0, 29))).toContain('3180,20260228');
  });

  it('an annual file built before the year\'s last 30 days is refused once, for the file', () => {
    expect(() => buildIrp5File({ employer, employees: [employee], asOf: new Date(2025, 10, 20) }))
      .toThrow(/^The annual e@syFile file for tax year 2026 can be built from 2026-01-29/);
    expect(buildIrp5File({ employer, employees: [employee], asOf: AFTER_YEAR })).toContain('3180,20260228');
  });
});
