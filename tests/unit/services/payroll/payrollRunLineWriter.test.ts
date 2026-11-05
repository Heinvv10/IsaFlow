/**
 * The run line writer stores the SDL state the year to date reads back (migration 957): the line's SDL-applicable pay,
 * the leviable amount it carried, and whether the run was SDL-exempt (s4(b)). It is the only writer of payroll_run_lines.
 */
import { describe, expect, it, vi } from 'vitest';

const { txMock } = vi.hoisted(() => ({ txMock: vi.fn(async () => []) }));
vi.mock('@/lib/neon', () => ({
  withTransaction: async (fn: (tx: typeof txMock) => Promise<void>) => fn(txMock),
}));

import { replaceRunLines, type LineInsert } from '@/modules/accounting/services/payroll/payrollRunLineWriter';

const insert = (over: Partial<LineInsert>): LineInsert => ({
  employeeId: 'e1', grossPay: 20_000, taxableIncome: 20_000, periodicTaxable: 20_000, annualTaxable: 0, paye: 0,
  medicalCredit: 0, additionalMedicalCredit: 0, medicalSchemeFees: 0, retirementContributions: 0, retirementDeduction: 0,
  uifEmployee: 0, uifEmployer: 0, sdl: 0, sdlLeviable: 14_500, sdlApplicable: 20_000, sdlExempt: true, eti: 0, netPay: 20_000,
  componentBreakdown: '[]', validationResults: '[]', ...over,
});

describe('replaceRunLines: SDL state (migration 957)', () => {
  it('inserts sdl_leviable, sdl_applicable and sdl_exempt with the levy, in the same statement', async () => {
    txMock.mockClear();
    await replaceRunLines('run-1', 'co-1', [insert({}), insert({ employeeId: 'e2', sdlExempt: false, sdl: 145 })]);
    const inserts = txMock.mock.calls.filter(c => (c[0] as unknown as TemplateStringsArray).join('?').includes('INSERT INTO payroll_run_lines'));
    expect(inserts).toHaveLength(2);
    const text = (inserts[0]![0] as unknown as TemplateStringsArray).join('?');
    expect(text).toContain('sdl, sdl_leviable, sdl_applicable, sdl_exempt, eti');
    // The holes after the template strings: run, employee, 10 money columns, uif x2, then sdl, sdl_leviable, sdl_applicable, sdl_exempt.
    const sdlState = (call: unknown[]) => call.slice(15, 19);
    expect(sdlState(inserts[0]!)).toEqual([0, 14_500, 20_000, true]);
    expect(sdlState(inserts[1]!)).toEqual([145, 14_500, 20_000, false]);
  });
});
