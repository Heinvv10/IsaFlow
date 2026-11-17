/**
 * The EMP501 filing file is the e@syFile file built from the version's STORED figures (wave 6 EFb): byte for byte the
 * reviewed golden (tests/unit/services/payroll/fixtures/easyfile-irp5.golden.txt) after the figures went through
 * JSONB (keys reordered, undefined dropped), with a stable sha256.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { EmployeeInput, EmployerInput } from '@/modules/accounting/services/payroll/easyFileExportService';
import { emp501FileOf } from '@/modules/accounting/services/returns/emp501FilingFile';

const golden = readFileSync(path.join(__dirname, '..', 'payroll', 'fixtures', 'easyfile-irp5.golden.txt'), 'utf8');

// The golden's input (easyFileExportService.test.ts).
const employer: EmployerInput = {
  tradingName: 'Marneweck Holdings', payeReferenceNumber: '7123456789', sdlReferenceNumber: 'L123456789',
  uifReferenceNumber: 'U123456789', contactFirstName: 'Jane', contactSurname: 'Horn', contactBusinessPhone: '0118765432',
  contactCellPhone: null, contactEmail: 'payroll@marneweck.co.za', transactionYear: 2026, reconciliationPeriod: 202602,
  sic7Code: '69201', physicalStreet: '12 Main Road', physicalSuburb: 'Rosebank', physicalCity: 'Johannesburg', physicalPostalCode: '2196',
};
const employee: EmployeeInput = {
  certificateNumber: '71234567892026020000000000000001'.slice(0, 30), yearOfAssessment: 2026, surname: 'Molefe',
  firstNames: 'Thandi Mbali', initials: 'TM', idNumber: '9001015009087', taxNumber: '0123456789',
  employmentStartDate: '20250301', employmentEndDate: null, periodsInYoA: 12, grossSalary3601: 360000, paye4102: 54000,
  uifEmployee: 177.12, uifEmployer: 177.12, sdl4142: 3600,
};

/** What a JSONB round trip gives back: keys in another order, undefined gone. */
function throughJsonb<T>(v: T): T {
  const shuffle = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(shuffle);
    if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).reverse().map(([k, val]) => [k, shuffle(val)]));
    return x;
  };
  return shuffle(JSON.parse(JSON.stringify(v))) as T;
}

const version = (figures: Record<string, unknown>) => ({ formType: 'EMP501' as const, figures: throughJsonb(figures) });

describe('emp501FileOf', () => {
  it('builds the reviewed golden byte for byte from stored annual figures', () => {
    const f = emp501FileOf(version({ taxYear: 2026, kind: 'annual', employer, employees: [{ ...employee, paye4582: undefined }] }));
    expect(f.body).toBe(golden);
    expect(f.sha256).toBe(createHash('sha256').update(golden, 'utf8').digest('hex'));
    expect(f.filename).toBe('IRP5_2025_2026_7123456789.irp5');
  });

  it('an interim version carries period 08 in 2031 and in the file name', () => {
    const f = emp501FileOf(version({
      taxYear: 2026, kind: 'interim', employer: { ...employer, reconciliationPeriod: 202608 },
      employees: [{ ...employee, certificateNumber: '712345678920260800000000000001', periodsInYoA: 6 }],
    }));
    expect(f.body.split('\r\n')).toContain('2031,202608');
    expect(f.body.split('\r\n')).toContain('3010,"712345678920260800000000000001"');
    expect(f.filename).toBe('IRP5_2025_2026_7123456789_08.irp5');
  });

  it('refuses a version of another form', () => {
    expect(() => emp501FileOf({ formType: 'EMP201', figures: {} })).toThrow(/no e@syFile file/);
  });
});
