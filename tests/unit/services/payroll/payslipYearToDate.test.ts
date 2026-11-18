/**
 * Wave 4 PS: the year-to-date bounds and filter. The PAYE tax year runs 1 March to the end
 * of February, so a February slip reads from the March before and a March slip starts a
 * new year. Only final runs count, plus the slip's own line (DRAFT or not). The SQL itself
 * is proven against Postgres in tests/integration/payslips.int.test.ts (the IRP5 tie).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({ params: [] as unknown[][], rows: [] as unknown[], final: new Set<string>() }));
vi.mock('@/lib/neon', () => ({
  withSavepoint: vi.fn(),
  sql: Object.assign(vi.fn(async (strings: TemplateStringsArray, ...vals: unknown[]) => {
    if (!strings.join('?').includes('prl.taxable_income')) throw new Error('unexpected query');
    db.params.push(vals);
    return db.rows;
  }), { unsafe: (raw: string) => raw }),
}));

import { payslipYearToDate } from '@/modules/accounting/services/payroll/payslipYearToDate';

/**
 * [startYear, startMonth] as bound into the query, and the end bound: this run itself or the runs before it in pay
 * order (wave 6 FQc: payrollRunOrder.runIsBeforeSql names the run; no month bound).
 */
const C = '00000000-0000-0000-0000-0000000000c1';
const id = (n: string) => `00000000-0000-0000-0000-${n.padStart(12, '0')}`;
const bounds = () => {
  const [, , startYear, startMonth, runId, before] = db.params.at(-1)!;
  expect(String(before)).toContain(`order_ref.id = '${String(runId)}'::uuid AND order_ref.company_id = '${C}'::uuid`);
  return [startYear, startMonth, runId];
};
const row = (runId: string, gross: string) =>
  ({ run_id: runId, final: db.final.has(runId), employee_id: 'e', gross_pay: gross, taxable_income: gross, paye: '1.00', uif_employee: '0.10', net_pay: '0.50' });

beforeEach(() => { db.params = []; db.rows = []; db.final = new Set(); });

describe('payslipYearToDate', () => {
  it('a February slip reads from the March before; a March slip starts the new tax year', async () => {
    await payslipYearToDate(C, { id: id('2'), periodMonth: 2, periodYear: 2027 }, ['e']);
    expect(bounds()).toEqual([2026, 3, id('2')]);
    await payslipYearToDate(C, { id: id('3'), periodMonth: 3, periodYear: 2027 }, ['e']);
    expect(bounds()).toEqual([2027, 3, id('3')]);
    await payslipYearToDate(C, { id: id('12'), periodMonth: 12, periodYear: 2026 }, ['e']);
    expect(bounds()).toEqual([2026, 3, id('12')]);
  });

  it('counts final runs and the slip\'s own line; an earlier non-final run is left out', async () => {
    db.final = new Set([id('12')]);
    db.rows = [row(id('11'), '100.00'), row(id('12'), '200.00'), row(id('2'), '400.00')]; // nov: earlier, not final
    const ytd = (await payslipYearToDate(C, { id: id('2'), periodMonth: 2, periodYear: 2027 }, ['e'])).get('e')!;
    expect(ytd).toEqual({ grossPay: 600, taxableIncome: 600, paye: 2, uifEmployee: 0.2, netPay: 1 });
  });

  it('the slip\'s own DRAFT line counts under its DRAFT mark', async () => {
    db.rows = [row(id('2'), '400.00')];
    expect((await payslipYearToDate(C, { id: id('2'), periodMonth: 2, periodYear: 2027 }, ['e'])).get('e')!.grossPay).toBe(400);
  });

  it('an employee with no rows has a zero year to date', async () => {
    expect((await payslipYearToDate(C, { id: id('2'), periodMonth: 2, periodYear: 2027 }, ['x'])).get('x')).toEqual({
      grossPay: 0, taxableIncome: 0, paye: 0, uifEmployee: 0, netPay: 0,
    });
  });
});
