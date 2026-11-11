/**
 * ETI qualifying-employee checks (wave 5 ET review round 2): ETI Act s6(a)(i) age at month end, s6(b) identity document,
 * s6(c)/(d) approval warning, and a rehire continuing the 24 months (s7(2)/(3)). SARS Guide to the Employment Tax
 * Incentive, Issue 5: §3.2.1 p. 24 (Example 3), §3.2.2 p. 25, §3.3 p. 28, §5.1 fn 142.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => []) }));

import { sql } from '@/lib/neon';
import { etiIdDocumentShown, isValidSaIdNumber } from '@/modules/accounting/services/payroll/etiEligibility';
import { calculateEti } from '@/modules/accounting/services/payroll/etiEngine';
import { withEtiPriorMonths } from '@/modules/accounting/services/payroll/etiPriorEmployment';
import { calculatePayrollLine } from '@/modules/accounting/services/payroll/payrollCalculator';
import { validateEti } from '@/modules/accounting/services/payroll/validationEngine';
import type { PayrollEmployee } from '@/modules/accounting/services/payroll/payrollTypes';

beforeEach(() => vi.clearAllMocks());

describe('s6(b): an identity document shown', () => {
  it('a valid SA ID number: 13 digits, a real date, the Luhn check digit', () => {
    expect(isValidSaIdNumber('8001015009087')).toBe(true);
    expect(isValidSaIdNumber('8001 0150 09087')).toBe(true);
    expect(isValidSaIdNumber('8001015009088')).toBe(false); // check digit
    expect(isValidSaIdNumber('8002305009081')).toBe(false); // 30 February
    expect(isValidSaIdNumber('800101500908')).toBe(false);  // 12 digits
    expect(isValidSaIdNumber(null)).toBe(false);
  });
  it('an asylum seeker permit or refugee ID recorded shows one without an ID number', () => {
    expect(etiIdDocumentShown({ idNumber: undefined, etiIdDocument: 'asylum_seeker_permit' })).toBe(true);
    expect(etiIdDocumentShown({ idNumber: undefined, etiIdDocument: 'refugee_id' })).toBe(true);
    expect(etiIdDocumentShown({ idNumber: undefined, etiIdDocument: 'sa_id' })).toBe(false);
    expect(etiIdDocumentShown({ idNumber: '8001015009087', etiIdDocument: null })).toBe(true);
  });
});

const employee = (over: Partial<PayrollEmployee> = {}): PayrollEmployee => ({
  id: 'e1', companyId: 'co', employeeNumber: 'E1', firstName: 'Young', lastName: 'Worker', employmentType: 'permanent',
  startDate: new Date(2026, 0, 1), dateOfBirth: new Date(2004, 5, 1), uifExcluded: false, medicalAidMainMember: false,
  medicalAidDependantsCount: 0, s18aReceiptHeld: false, taxStatus: 'employee', payBasis: 'monthly', hoursPerWeek: 40, ...over,
});
const line = (e: PayrollEmployee) => calculatePayrollLine({
  employee: e, components: [{ component: { id: 'b', name: 'Basic', sarsSourceCode: '3601', componentType: 'earning', isTaxable: true, isUifApplicable: true, isSdlApplicable: true }, amount: 5_300 }],
  period: { month: 3, year: 2026 }, taxYear: 2027, annualPayrollEstimate: 1_000_000,
});

describe('the calculator', () => {
  it('no document shown: no ETI, not determinable, and validateEti says what is missing', () => {
    const r = line(employee({ idNumber: '1234567890123' }));
    expect(r.eti).toMatchObject({ monthlyEti: 0, isDeterminable: false, missingInputs: ['id_document'] });
    expect(validateEti(employee(), r.eti)[0]!.message).toMatch(/valid SA ID number, or an asylum seeker permit or refugee identity document/);
  });
  it('a refugee identity document recorded: claims, with the connected-person / domestic-worker approval warning', () => {
    const r = line(employee({ etiIdDocument: 'refugee_id' }));
    expect(r.eti.monthlyEti).toBe(1_500);
    expect(r.validationResults.find((v) => v.code === 'ETI_CONNECTED_OR_DOMESTIC_UNCHECKED')?.severity).toBe('warning');
  });
});

const eti = (dob: Date, periodDate: Date, priorMonths = 0, start = new Date(2026, 0, 1)) => calculateEti({
  dateOfBirth: dob, employmentStartDate: start, periodDate, monthlyRemuneration: 5_000, isUifExcluded: false, priorMonths,
});

describe('s6(a)(i): 18 to 29 at the END of the month (guide Example 3)', () => {
  it('turning 30 on 30 June 2026: May qualifies, June does not (on the 28th the employee was still 29)', () => {
    const dob = new Date(1996, 5, 30);
    expect(eti(dob, new Date(2026, 4, 28)).monthlyEti).toBe(1_500);
    expect(eti(dob, new Date(2026, 5, 28)).monthlyEti).toBe(0);
  });
  it('turning 18 on 30 June 2026: June qualifies', () => {
    expect(eti(new Date(2008, 5, 30), new Date(2026, 5, 28)).monthlyEti).toBe(1_500);
  });
});

describe('a rehire continues the 24 months (guide §3.3: they need not be consecutive)', () => {
  it('12 months on an earlier record: the first month back is in the second-year band; 24 months: the window is spent', () => {
    expect(eti(new Date(2004, 0, 1), new Date(2026, 0, 28), 12).monthlyEti).toBe(750);
    expect(eti(new Date(2004, 0, 1), new Date(2026, 0, 28), 24).monthlyEti).toBe(0);
  });
  it('withEtiPriorMonths: months on earlier records with the same ID number that ended before this start date', async () => {
    vi.mocked(sql).mockResolvedValueOnce([
      { id: 'old', id_number: '8001015009087', start_date: '2024-03-15', end_date: '2025-02-10' }, // Mar 2024 - Feb 2025: 12
      { id: 'e1', id_number: '8001015009087', start_date: '2026-01-01', end_date: '2026-12-31' },  // itself: never
      { id: 'later', id_number: '8001015009087', start_date: '2026-03-01', end_date: '2026-04-30' }, // after: never
    ] as never);
    const [e] = await withEtiPriorMonths('co', [employee({ idNumber: '8001 0150 09087' })]);
    expect(e!.etiPriorMonths).toBe(12);
    const call = vi.mocked(sql).mock.calls[0]!;
    expect((call[0] as TemplateStringsArray).join('?')).toContain('company_id = ?::uuid');
    expect(call.slice(1)).toEqual(['co', ['8001015009087']]);
  });
});
