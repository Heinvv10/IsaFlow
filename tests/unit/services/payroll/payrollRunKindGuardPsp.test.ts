/**
 * Wave 6 PSP lifts FQa's unknown-status clause for personal service providers for every action, the IRP5 included: a
 * PSP's months are decided per line on the filings (pspLineFlag, pspFiling), so the company's other employees, and the
 * PSP's own months as an employee, are never blocked (review of #1566, M2).
 */
import { describe, expect, it } from 'vitest';
import { judgeRunKind, KNOWN_TAX_STATUSES, type RunKindAction } from '@/modules/accounting/services/payroll/payrollRunKindGuard';

const ALL: RunKindAction[] = ['calculate', 'approve', 'post', 'reopen', 'payslip', 'emp201', 'irp5', 'bank_file'];
const OK = {
  pay_frequency: 'monthly', run_kind: 'regular', unknown_status: null, other_frequency: null, odd_assignments: null,
  garnishee_orders: 0, garnishee_deductions: 0,
};

describe('the PSP clause', () => {
  it('personal_service_provider is a known status: the unknown-status clause no longer reads it', () => {
    expect(KNOWN_TAX_STATUSES).toContain('personal_service_provider');
  });

  it('no action refuses a run because a PSP is on it (the IRP5 neither)', () => {
    expect(ALL.filter((a) => judgeRunKind({ ...OK, psp_people: ['P1', 'P2'] }, a).length > 0)).toEqual([]);
  });
});
