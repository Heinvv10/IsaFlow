/**
 * Wave 6 PSP lifts FQa's unknown-status clause for personal service providers, except for the IRP5: a PSP's certificate
 * is issued to a company or trust (a different nature of person, with no date of birth), which this release does not
 * produce, so a year with a PSP on a final run is refused by name rather than certified as a natural person.
 * The SQL that fills psp_people is proven on real PostgreSQL in tests/integration/w6-psp.int.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { judgeRunKind, KNOWN_TAX_STATUSES, type RunKindAction } from '@/modules/accounting/services/payroll/payrollRunKindGuard';

const ALL: RunKindAction[] = ['calculate', 'approve', 'post', 'reopen', 'payslip', 'emp201', 'irp5', 'bank_file'];
const OK = {
  pay_frequency: 'monthly', run_kind: 'regular', unknown_status: null, other_frequency: null, odd_assignments: null,
  garnishee_orders: 0, garnishee_deductions: 0, psp_people: null,
};

describe('the PSP clause', () => {
  it('personal_service_provider is a known status: the unknown-status clause no longer reads it', () => {
    expect(KNOWN_TAX_STATUSES).toContain('personal_service_provider');
  });

  it('a PSP on the run is refused for the IRP5 only, naming them', () => {
    const refused = ALL.filter((a) => judgeRunKind({ ...OK, psp_people: ['P1', 'P2'] }, a).length > 0);
    expect(refused).toEqual(['irp5']);
    const [reason] = judgeRunKind({ ...OK, psp_people: ['P1', 'P2'] }, 'irp5');
    expect(reason!.clause).toBe('tax_status');
    expect(reason!.detail).toContain('P1, P2');
    expect(reason!.detail).toContain('personal service provider');
  });
});
