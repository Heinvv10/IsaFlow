/**
 * PAYE 4c review (#891): createComponent refuses a paidOutsidePayroll that is not a boolean ("true" or 1 would
 * read as false, and a private contribution would come out of net pay), and the flag anywhere but a deduction
 * coded 4001/4003/4006, before any query.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sqlCalls: unknown[][] = [];
vi.mock('@/lib/neon', () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => {
    sqlCalls.push(values);
    return Promise.resolve([{ id: 'c1', name: 'RA', sars_source_code: '4006', component_type: 'deduction', is_taxable: false,
      is_uif_applicable: false, is_sdl_applicable: false, paid_outside_payroll: values.includes(true) }]);
  },
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { createComponent, PaidOutsidePayrollRefusedError } from '@/modules/accounting/services/payroll/payrollComponentService';

const base = { name: 'RA', sarsSourceCode: '4006', componentType: 'deduction' as const, isTaxable: false, isUifApplicable: false, isSdlApplicable: false };
beforeEach(() => { sqlCalls.length = 0; });

describe('createComponent: paidOutsidePayroll', () => {
  it('refuses a value that is not a boolean, before any query', async () => {
    for (const bad of ['true', 1, 'false', null]) {
      await expect(createComponent('co', { ...base, paidOutsidePayroll: bad as never })).rejects.toBeInstanceOf(PaidOutsidePayrollRefusedError);
    }
    expect(sqlCalls).toHaveLength(0);
  });

  it('refuses it on a component that cannot carry it', async () => {
    await expect(createComponent('co', { ...base, sarsSourceCode: '4005', paidOutsidePayroll: true })).rejects.toThrow(/only a retirement fund contribution/i);
    expect(sqlCalls).toHaveLength(0);
  });

  it('writes true, false and absent as given', async () => {
    expect((await createComponent('co', { ...base, paidOutsidePayroll: true })).paidOutsidePayroll).toBe(true);
    expect((await createComponent('co', { ...base, paidOutsidePayroll: false })).paidOutsidePayroll).toBe(false);
    expect((await createComponent('co', base)).paidOutsidePayroll).toBe(false);
  });
});
