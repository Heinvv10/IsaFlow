/**
 * The run line writer stores the SDL state the year to date reads back (migration 957): the line's SDL-applicable pay,
 * the leviable amount it carried, and whether the run was SDL-exempt (s4(b)). It is the only writer of payroll_run_lines.
 *
 * The test maps each INSERT value to its COLUMN by name (the column list against the template's holes), so a swapped
 * mapping goes red and adding a column breaks nothing.
 */
import { describe, expect, it, vi } from 'vitest';

const { txMock } = vi.hoisted(() => ({ txMock: vi.fn(async () => []) }));
vi.mock('@/lib/neon', () => ({
  withTransaction: async (fn: (tx: typeof txMock) => Promise<void>) => fn(txMock),
}));

import { replaceRunLines, type LineInsert } from '@/modules/accounting/services/payroll/payrollRunLineWriter';

const insert = (over: Partial<LineInsert>): LineInsert => ({
  employeeId: 'e1', grossPay: 21_000, taxableIncome: 20_500, periodicTaxable: 20_400, annualTaxable: 0, paye: 0,
  medicalCredit: 0, additionalMedicalCredit: 0, medicalSchemeFees: 0, retirementContributions: 0, retirementDeduction: 0,
  uifEmployee: 0, uifEmployer: 0, sdl: 0, sdlLeviable: 14_500, sdlApplicable: 20_000, sdlExempt: true, eti: 0, netPay: 20_000,
  componentBreakdown: '[]', validationResults: '[]', ...over,
});

/** Column name -> inserted value for each INSERT INTO payroll_run_lines the writer made. */
function insertedRows(): Array<Record<string, unknown>> {
  return txMock.mock.calls.flatMap((call) => {
    const strings = (call as unknown as [TemplateStringsArray, ...unknown[]])[0];
    const values = (call as unknown as unknown[]).slice(1);
    const text = strings.join('?');
    if (!text.includes('INSERT INTO payroll_run_lines')) return [];
    const columns = text.slice(text.indexOf('(') + 1, text.indexOf(') VALUES')).split(',').map(c => c.trim());
    // A column whose value is an SQL expression (created_at: clock_timestamp()) has no hole; the holes follow the columns in order.
    const holes = columns.filter(c => c !== 'created_at');
    return [Object.fromEntries(holes.map((c, i) => [c, values[i]]))];
  });
}

describe('replaceRunLines: SDL state (migration 957)', () => {
  it('stores sdl_leviable, sdl_applicable and sdl_exempt beside sdl, each in its own column', async () => {
    txMock.mockClear();
    await replaceRunLines('run-1', 'co-1', [
      insert({}),
      insert({ employeeId: 'e2', sdl: 145, sdlLeviable: 14_500, sdlApplicable: 20_000, sdlExempt: false }),
    ]);
    const rows = insertedRows();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      run_id: 'run-1', employee_id: 'e1', sdl: 0, sdl_leviable: 14_500, sdl_applicable: 20_000, sdl_exempt: true,
      gross_pay: 21_000, taxable_income: 20_500, periodic_taxable: 20_400, net_pay: 20_000,
    });
    expect(rows[1]).toMatchObject({ employee_id: 'e2', sdl: 145, sdl_leviable: 14_500, sdl_applicable: 20_000, sdl_exempt: false });
  });

  it('keeps the three SDL columns distinct from one another (a swap shows)', async () => {
    txMock.mockClear();
    await replaceRunLines('run-2', 'co-1', [insert({ sdl: 7, sdlLeviable: 8, sdlApplicable: 9, sdlExempt: false })]);
    expect(insertedRows()[0]).toMatchObject({ sdl: 7, sdl_leviable: 8, sdl_applicable: 9, sdl_exempt: false });
  });
});
