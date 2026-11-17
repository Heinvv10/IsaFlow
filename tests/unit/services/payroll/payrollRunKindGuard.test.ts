/**
 * Wave 6 FQa: which clause refuses which action (payrollRunKindGuard.judgeRunKind), the error's code, and the one
 * route answer (409 RUN_KIND_UNSUPPORTED through respondToUnhandledError). The SQL that fills the row is proven on
 * real PostgreSQL in tests/integration/w6-freq-schema.int.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { judgeRunKind, RunKindUnsupportedError, type RunKindAction } from '@/modules/accounting/services/payroll/payrollRunKindGuard';
import { respondToUnhandledError } from '@/lib/api-error-handler';
import { REFUSAL_CODES } from '@/lib/mcp/tools/refusalCodes';
import { mapRunRow } from '@/modules/accounting/services/payroll/payrollRunHeaders';
import { mapPayrollEmployeeRow } from '@/modules/accounting/services/payroll/payrollEmployeeService';

const ALL: RunKindAction[] = ['calculate', 'approve', 'post', 'reopen', 'payslip', 'emp201', 'irp5', 'bank_file'];
const OK = {
  pay_frequency: 'monthly', run_kind: 'regular', unknown_status: null, other_frequency: null, odd_assignments: null,
  garnishee_orders: 0, garnishee_deductions: 0,
};
const refusedBy = (row: Record<string, unknown>) =>
  ALL.filter((a) => judgeRunKind({ ...OK, ...row }, a).length > 0);

describe('judgeRunKind: the clause matrix', () => {
  it('passes a monthly regular run with nothing unknown, for every action', () => {
    expect(refusedBy({})).toEqual([]);
  });

  it('refuses a weekly or fortnightly run, and an off-cycle run, for every action', () => {
    expect(refusedBy({ pay_frequency: 'weekly' })).toEqual(ALL);
    expect(refusedBy({ pay_frequency: 'fortnightly' })).toEqual(ALL);
    expect(refusedBy({ run_kind: 'off_cycle' })).toEqual(ALL);
    expect(judgeRunKind({ ...OK, run_kind: 'off_cycle' }, 'reopen')[0]!.detail).toContain('off-cycle run');
  });

  it('refuses garnishee deductions on the run for every action, reopen included (grill F8)', () => {
    expect(refusedBy({ garnishee_deductions: 1 })).toEqual(ALL);
  });

  it('refuses an unknown tax status for everything but reopen, naming the employees', () => {
    expect(refusedBy({ unknown_status: ['E1', 'E2'] })).toEqual(ALL.filter((a) => a !== 'reopen'));
    expect(judgeRunKind({ ...OK, unknown_status: ['E1', 'E2'] }, 'approve')[0]!.detail).toContain('E1, E2');
  });

  it("refuses a line employee off the run's frequency for everything but calculate (which filters) and reopen", () => {
    expect(refusedBy({ other_frequency: ['E1'] })).toEqual(ALL.filter((a) => a !== 'calculate' && a !== 'reopen'));
  });

  it('judges the frequency as at a FINAL run: only approve and post meet the current employee (wave 6 FQd)', () => {
    // An employee moved to weekly at a tax-year start keeps last year's payslips, EMP201 and IRP5.
    expect(refusedBy({ other_frequency: ['E1'], final: true })).toEqual(['approve', 'post']);
    expect(refusedBy({ other_frequency: ['E1'], final: false })).toEqual(ALL.filter((a) => a !== 'calculate' && a !== 'reopen'));
  });

  it('refuses odd assignments and active garnishee orders only where the run is costed', () => {
    expect(refusedBy({ odd_assignments: ['E1'] })).toEqual(['calculate', 'approve', 'post']);
    expect(refusedBy({ garnishee_orders: 2 })).toEqual(['calculate', 'approve', 'post']);
  });

  it('reports every clause that holds, in order', () => {
    expect(judgeRunKind({ ...OK, pay_frequency: 'weekly', run_kind: 'off_cycle', odd_assignments: ['E1'] }, 'approve')
      .map((r) => r.clause)).toEqual(['frequency', 'run_kind', 'assignment']);
  });
});

describe('RunKindUnsupportedError', () => {
  const err = new RunKindUnsupportedError('approve', [{ clause: 'frequency', detail: 'it is a weekly run, and only monthly runs are supported' }]);

  it('carries the code an MCP agent is shown verbatim', () => {
    expect(err.code).toBe('RUN_KIND_UNSUPPORTED');
    expect(REFUSAL_CODES.has(err.code)).toBe(true);
    expect(err.message).toBe('This pay run cannot be approved by this version of IsaFlow: it is a weekly run, and only monthly runs are supported.');
  });

  it('is answered 409 with its reasons by the shared error responder', () => {
    const state: { status?: number; body?: unknown } = {};
    const res = {
      status(code: number) { state.status = code; return this; },
      json(body: unknown) { state.body = body; return this; },
      setHeader() { return this; },
    };
    respondToUnhandledError(res as never, err);
    expect(state.status).toBe(409);
    expect(JSON.stringify(state.body)).toContain('RUN_KIND_UNSUPPORTED');
    expect(JSON.stringify(state.body)).toContain('"clause":"frequency"');
  });
});

describe('a value a later release added (review #1483): listed, then refused', () => {
  const header = { id: 'r1', company_id: 'c1', period_month: 4, period_year: 2026, status: 'calculated' };

  it('maps an unknown frequency, kind or reason to unsupported instead of failing the whole list', () => {
    const run = mapRunRow({ ...header, pay_frequency: 'biweekly', run_kind: 'correction', off_cycle_reason: 'retro' });
    expect(run).toMatchObject({ payFrequency: 'unsupported', runKind: 'unsupported', offCycleReason: 'unsupported' });
    expect(mapRunRow({ ...header, pay_frequency: 'weekly', run_kind: 'off_cycle', off_cycle_reason: 'bonus' }))
      .toMatchObject({ payFrequency: 'weekly', runKind: 'off_cycle', offCycleReason: 'bonus' });
    const employee = mapPayrollEmployeeRow({ id: 'e1', company_id: 'c1', employee_number: 'E1', first_name: 'A', last_name: 'B',
      employment_type: 'permanent', start_date: '2020-01-01', tax_status: 'employee', pay_basis: 'monthly', pay_frequency: 'biweekly' });
    expect(employee.payFrequency).toBe('unsupported');
  });

  it('the guard refuses such a run for every action, by its database value', () => {
    expect(refusedBy({ pay_frequency: 'biweekly' })).toEqual(ALL);
    expect(refusedBy({ run_kind: 'correction' })).toEqual(ALL);
    expect(judgeRunKind({ ...OK, run_kind: 'correction' }, 'approve')[0]!.detail).toBe("it is a 'correction' run, and only regular runs are supported");
  });
});

