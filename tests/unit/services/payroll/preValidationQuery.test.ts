/** Wave 6 PV: the pre-validation query parser is strict: every key accounted for, anything else refused. */
import { describe, expect, it } from 'vitest';
import { parsePreValidationQuery } from '@/modules/accounting/services/payroll/preValidationQuery';
import { fixFor } from '@/modules/accounting/services/payroll/preValidationService';
import { currentPayeTaxYear } from '@/modules/accounting/utils/payeTaxYearToday';

const U = '11111111-1111-4111-8111-111111111111';

describe('parsePreValidationQuery', () => {
  it('accepts no scope, a tax year, an employee (with or without a year) and a run', () => {
    expect(parsePreValidationQuery({})).toEqual({});
    expect(parsePreValidationQuery({ taxYear: '2027' })).toEqual({ taxYear: 2027 });
    expect(parsePreValidationQuery({ employeeId: U, taxYear: '2026' })).toEqual({ employeeId: U, taxYear: 2026 });
    expect(parsePreValidationQuery({ runId: U })).toEqual({ runId: U });
  });
  it.each([
    [{ year: '2027' }, /^Unknown query parameter: only taxYear, employeeId and runId are accepted$/],
    [{ taxYear: ['2027', '2026'] }, /once/],
    [{ taxYear: '27' }, /taxYear/],
    [{ taxYear: '2027.5' }, /taxYear/],
    [{ taxYear: '1999' }, /taxYear/],
    [{ taxYear: '2101' }, /taxYear/],
    [{ employeeId: 'abc' }, /employeeId must be a UUID/],
    [{ runId: `${U}x` }, /runId must be a UUID/],
    [{ employeeId: U, runId: U }, /not both/],
    [{ runId: U, taxYear: '2027' }, /own tax year/],
  ])('refuses %j', (query, reason) => {
    const out = parsePreValidationQuery(query as never);
    expect(typeof out).toBe('string');
    expect(out).toMatch(reason);
  });
});

describe('fixFor (where each issue is fixed)', () => {
  const E = 'e1';
  it('tax and ID numbers go to their profile fields', () => {
    expect(fixFor(E, { severity: 'error', code: 'IRP5_MISSING_TAX_NUMBER', message: '', field: 'tax_number' }).fixHref).toBe('/payroll/employees/e1#employee-tax-number');
    expect(fixFor(E, { severity: 'warning', code: 'IRP5_INVALID_ID', message: '', field: 'id_number' }).fixHref).toBe('/payroll/employees/e1#employee-id-number');
  });
  it('a severance without a directive goes to the tax directives; a code fault to the pay components', () => {
    expect(fixFor(E, { severity: 'warning', code: 'IRP5_SEVERANCE_WITHOUT_DIRECTIVE', message: '' }).fixHref).toBe('/payroll/tax-directives');
    expect(fixFor(E, { severity: 'error', code: 'IRP5_UNKNOWN_CODE', message: '' }).fixHref).toBe('/payroll/employees/e1#employee-pay');
  });
});

describe('currentPayeTaxYear (SAST date, March starts the year)', () => {
  it('28 Feb 2027 is tax year 2027; 1 Mar 2027 SAST (still 28 Feb UTC 22:30) is 2028', () => {
    expect(currentPayeTaxYear(new Date('2027-02-28T12:00:00Z'))).toBe(2027);
    expect(currentPayeTaxYear(new Date('2027-02-28T22:30:00Z'))).toBe(2028);
  });
});
