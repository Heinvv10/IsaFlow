/**
 * Wave 6 PSP-H: a personal service provider's entity particulars, judged before any write. SARS PAYE Employer
 * Reconciliation BRS V25.3.0: 3030 FT120 trading name for nature of person H (p. 20); 3066 FT30, and for alternate ID type 1
 * (a company / CC) the format CCYY/NNNNNN/NN, CCYY from 1800 to this year, the last two digits one of 06, 07, 08, 09, 10, 11,
 * 20-26, 30, 31 (p. 24); 3100 ten digits starting with 9 for E, G and H (p. 26-27); no comma or pipe in any value (§3).
 */
import { describe, expect, it } from 'vitest';
import {
  PSP_PARTICULAR_KEYS, pspParticularsFromRow, pspParticularsOfPatch, pspRegistrationProblem,
} from '@/modules/accounting/services/payroll/payrollEmployeePspEntity';

const refuse = (m: string) => new Error(m);
const PSP = 'personal_service_provider';

describe('pspRegistrationProblem', () => {
  it('a company (alternate ID type 1): CCYY/NNNNNN/NN, a year from 1800 to this year, a SARS-listed suffix', () => {
    expect(pspRegistrationProblem('company', '2015/123456/07', 2026)).toBeNull();
    expect(pspRegistrationProblem('company', '1800/000001/31', 2026)).toBeNull();
    expect(pspRegistrationProblem('company', '2015/12345/07', 2026)).toMatch(/CCYY\/NNNNNN\/NN/);
    expect(pspRegistrationProblem('company', '1799/123456/07', 2026)).toMatch(/year/);
    expect(pspRegistrationProblem('company', '2027/123456/07', 2026)).toMatch(/year/);
    expect(pspRegistrationProblem('company', '2015/123456/12', 2026)).toMatch(/06, 07/);
  });
  it('a trust (type 2): free text up to 30, no comma or pipe', () => {
    expect(pspRegistrationProblem('trust', 'IT1234/2019', 2026)).toBeNull();
    expect(pspRegistrationProblem('trust', 'IT1,234', 2026)).toMatch(/comma/);
    expect(pspRegistrationProblem('trust', 'x'.repeat(31), 2026)).toMatch(/30/);
  });
});

describe('pspParticularsOfPatch', () => {
  it('a PSP: trimmed, judged; blank clears', () => {
    expect(pspParticularsOfPatch({ pspEntityName: '  Acme Consulting (Pty) Ltd ', pspRegistrationNumber: '2015/123456/07', pspTaxReference: '9012345678' },
      PSP, 'company', refuse, 2026)).toEqual({ pspEntityName: 'Acme Consulting (Pty) Ltd', pspRegistrationNumber: '2015/123456/07', pspTaxReference: '9012345678' });
    expect(pspParticularsOfPatch({ pspRegistrationNumber: '' }, PSP, 'company', refuse, 2026)).toEqual({ pspRegistrationNumber: null });
    expect(pspParticularsOfPatch({}, PSP, 'company', refuse, 2026)).toEqual({});
  });
  it('refuses a tax reference not 10 digits starting with 9, a name over 120 or with a comma, a bad company number', () => {
    expect(() => pspParticularsOfPatch({ pspTaxReference: '0123456789' }, PSP, 'company', refuse, 2026)).toThrow(/starting with 9/);
    expect(() => pspParticularsOfPatch({ pspTaxReference: '912345678' }, PSP, 'company', refuse, 2026)).toThrow(/starting with 9/);
    expect(() => pspParticularsOfPatch({ pspEntityName: 'x'.repeat(121) }, PSP, 'company', refuse, 2026)).toThrow(/120/);
    expect(() => pspParticularsOfPatch({ pspEntityName: 'Acme, Inc' }, PSP, 'company', refuse, 2026)).toThrow(/comma/);
    expect(() => pspParticularsOfPatch({ pspRegistrationNumber: 'IT1234/2019' }, PSP, 'company', refuse, 2026)).toThrow(/CCYY\/NNNNNN\/NN/);
    expect(() => pspParticularsOfPatch({ pspEntityName: 7 }, PSP, 'company', refuse, 2026)).toThrow(/text/);
  });
  it('anyone else: a particular given is refused; moving off PSP (or no status known as PSP) clears all three', () => {
    expect(() => pspParticularsOfPatch({ pspEntityName: 'Acme' }, 'employee', null, refuse, 2026)).toThrow(/personal service provider/);
    expect(pspParticularsOfPatch({ taxStatus: 'employee' }, 'employee', null, refuse, 2026))
      .toEqual({ pspEntityName: null, pspRegistrationNumber: null, pspTaxReference: null });
  });
});

describe('pspParticularsFromRow', () => {
  it('maps the three columns, null when absent', () => {
    expect(pspParticularsFromRow({ psp_entity_name: 'Acme', psp_registration_number: null, psp_tax_reference: '9012345678' }))
      .toEqual({ pspEntityName: 'Acme', pspRegistrationNumber: null, pspTaxReference: '9012345678' });
    expect(pspParticularsFromRow({})).toEqual({ pspEntityName: null, pspRegistrationNumber: null, pspTaxReference: null });
    expect(PSP_PARTICULAR_KEYS).toEqual(['pspEntityName', 'pspRegistrationNumber', 'pspTaxReference']);
  });
});
