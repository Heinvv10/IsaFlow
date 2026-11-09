/**
 * taxStatusTreatment / payeUnderTreatment / validateEmploymentTerms. Sources: PAYE-GEN-01-G21 (2027) Rev 1 p. 26 (an independent
 * contractor's income is not remuneration), p. 27 (director: an employee; no monthly rule of its own), p. 28 (non-standard: 25%
 * of the balance of remuneration).
 */
import { describe, expect, it } from 'vitest';
import { taxStatusTreatment, payeUnderTreatment, outsideTablesResult } from '@/modules/accounting/services/payroll/taxStatusTreatment';
import { validateEmploymentTerms } from '@/modules/accounting/services/payroll/validationEngine';
import type { EmployeeComponent, PayrollEmployee } from '@/modules/accounting/services/payroll/payrollTypes';

describe('taxStatusTreatment', () => {
  it('an employee in standard, deemed standard or undetermined employment is on the tables with UIF, SDL and ETI', () => {
    for (const kind of ['standard', 'deemed_standard', 'undetermined'] as const) {
      expect(taxStatusTreatment('employee', kind)).toEqual({ paye: 'tables', uif: true, sdl: true, eti: true });
    }
  });

  it('non-standard employment is a flat 25%, UIF/SDL/ETI unchanged', () => {
    expect(taxStatusTreatment('employee', 'non_standard_flat')).toEqual({ paye: 'flat_25', uif: true, sdl: true, eti: true });
  });

  it('an independent contractor has no PAYE, UIF, SDL or ETI, whatever the class', () => {
    for (const kind of ['standard', 'non_standard_flat', 'undetermined'] as const) {
      expect(taxStatusTreatment('independent_contractor', kind)).toEqual({ paye: 'none', uif: false, sdl: false, eti: false });
    }
  });

  it('a director is on the tables like an employee, and is never flat-rated (G21 p. 27)', () => {
    expect(taxStatusTreatment('director', 'standard')).toEqual({ paye: 'tables', uif: true, sdl: true, eti: true });
    expect(taxStatusTreatment('director', 'non_standard_flat').paye).toBe('tables');
  });
});

describe('payeUnderTreatment', () => {
  const tables = { regular: 1_000, annualPayment: 200 };
  it('tables: unchanged', () => expect(payeUnderTreatment('tables', tables, 50_000)).toEqual(tables));
  it('none: nil', () => expect(payeUnderTreatment('none', tables, 50_000)).toEqual({ regular: 0, annualPayment: 0 }));
  it('flat: 25% of the balance, to the cent, nil below nil', () => {
    expect(payeUnderTreatment('flat_25', tables, 4_500)).toEqual({ regular: 1_125, annualPayment: 0 });
    expect(payeUnderTreatment('flat_25', tables, 100.01)).toEqual({ regular: 25, annualPayment: 0 });
    expect(payeUnderTreatment('flat_25', tables, -50)).toEqual({ regular: 0, annualPayment: 0 });
  });
});

describe('the line flag', () => {
  it('names the treatment and, for flat, the declaration limit', () => {
    const [flat] = outsideTablesResult('flat_25');
    expect([flat!.code, flat!.treatment]).toEqual(['PAYE_OUTSIDE_TABLES', 'flat_25']);
    expect(flat!.message).toContain('written declaration');
    const [none] = outsideTablesResult('none');
    expect(none!.treatment).toBe('none');
    expect(none!.message).toContain('independent-contractor tests');
  });
});

const person = (o: Partial<PayrollEmployee>) => ({ id: 'e1', firstName: 'A', lastName: 'B', employmentType: 'permanent', taxStatus: 'employee', ...o }) as PayrollEmployee;
const earning = (uif: boolean, sdl: boolean): EmployeeComponent => ({
  component: { id: 'c', name: 'Fees', sarsSourceCode: '3601', componentType: 'earning', isTaxable: true, isUifApplicable: uif, isSdlApplicable: sdl }, amount: 1000,
});
const classification = (kind: 'standard' | 'undetermined', hoursNotRecorded = false) => ({ kind, reason: 'because', hoursNotRecorded });
const codes = (r: ReturnType<typeof validateEmploymentTerms>) => r.map(x => `${x.severity}:${x.code}`);

describe('validateEmploymentTerms', () => {
  it('monthly with no hours: an info result, never silent', () => {
    expect(codes(validateEmploymentTerms(person({}), classification('standard', true), []))).toEqual(['info:HOURS_NOT_RECORDED']);
  });
  it('undetermined: a blocking error', () => {
    expect(codes(validateEmploymentTerms(person({}), classification('undetermined'), []))).toEqual(['error:EMPLOYMENT_UNDETERMINED']);
  });
  it('employment type director with tax status employee: a blocking error (the card asks)', () => {
    expect(codes(validateEmploymentTerms(person({ employmentType: 'director' }), classification('standard'), []))).toEqual(['error:DIRECTOR_STATUS_NOT_SET']);
    expect(validateEmploymentTerms(person({ employmentType: 'director', taxStatus: 'director' }), classification('standard'), [])).toEqual([]);
  });
  it('a contractor whose earnings carry UIF or SDL flags: a warning that they are set aside', () => {
    const c = person({ taxStatus: 'independent_contractor' });
    expect(codes(validateEmploymentTerms(c, classification('standard'), [earning(true, false)]))).toEqual(['warning:CONTRACTOR_UIF_SDL_IGNORED']);
    expect(codes(validateEmploymentTerms(c, classification('standard'), [earning(false, true)]))).toEqual(['warning:CONTRACTOR_UIF_SDL_IGNORED']);
    expect(validateEmploymentTerms(c, classification('standard'), [earning(false, false)])).toEqual([]);
  });
});
