/**
 * EMP201 drill-down arithmetic in hand-written cents. `sql` returns the rows the
 * run query would; which runs the query SELECTS (approved/paid only, this company)
 * is proved against real PostgreSQL in tests/integration/w5-return-drill.int.test.ts,
 * and here by what is bound to the query.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[], directives: [] as unknown[], sql: vi.fn() }));
vi.mock('@/lib/neon', () => ({ sql: mocks.sql }));
vi.mock('@/modules/accounting/services/payroll/directivePaymentFiling', () => ({
  listStandaloneDirectivePayments: vi.fn(async () => mocks.directives),
}));

import { emp201FieldDrill } from '@/modules/accounting/services/reports/emp201FieldDrill';

const run = (id: string, month: number, over: Record<string, unknown> = {}) => ({
  run_id: id, period_year: 2026, period_month: month, status: 'approved',
  total_paye: 3000, total_eti: 100, total_uif: 400, total_sdl: 200, total_gross: 30000, ...over,
});
const line = (r: Record<string, unknown>, emp: string, over: Record<string, unknown> = {}) => ({
  ...r, line_id: `${String(r.run_id)}-${emp}`, employee_id: emp, employee_number: emp.toUpperCase(), employee_name: `Emp ${emp}`,
  paye: 1500, eti: 50, uif: 200, sdl: 100, gross_pay: 15000, non_cash: 0, ...over,
});

describe('emp201FieldDrill', () => {
  beforeEach(() => {
    mocks.sql.mockReset();
    mocks.sql.mockImplementation(async () => mocks.rows);
    mocks.directives = [];
    const r = run('r1', 5);
    mocks.rows = [line(r, 'a'), line(r, 'b')];
  });

  it('binds this company and only the approved and paid statuses', async () => {
    await emp201FieldDrill('co-a', '2026-05-01', '2026-05-31', 'paye');
    const values = mocks.sql.mock.calls[0]!.slice(1);
    expect(values).toContain('co-a');
    expect(values).toContainEqual(['approved', 'paid']);
  });

  it('lists per employee per run, and the lines add to the header', async () => {
    const r = await emp201FieldDrill('co-a', '2026-05-01', '2026-05-31', 'paye');
    expect(r).toMatchObject({ total: 3000, rowsTotal: 3000, ties: true, rowCount: 2 });
    expect(r!.rows.map((x) => [x.employeeId, x.amount])).toEqual([['a', 1500], ['b', 1500]]);
    expect(r!.runs[0]).toMatchObject({ headerTotal: 3000, linesTotal: 3000, difference: 0 });
  });

  it('shows a header that disagrees with its lines instead of hiding it', async () => {
    mocks.rows = [line(run('r1', 5, { total_paye: 3050 }), 'a'), line(run('r1', 5, { total_paye: 3050 }), 'b')];
    const r = await emp201FieldDrill('co-a', '2026-05-01', '2026-05-31', 'paye');
    expect(r).toMatchObject({ total: 3050, rowsTotal: 3000, ties: false });
    expect(r!.runs[0]!.difference).toBe(50);
  });

  it('uif is employee plus employer per line; remuneration adds non-cash benefits to cash gross', async () => {
    expect(await emp201FieldDrill('co-a', '2026-05-01', '2026-05-31', 'uif')).toMatchObject({ total: 400, rowsTotal: 400 });
    const r = run('r1', 5);
    mocks.rows = [line(r, 'a', { non_cash: 250.5 }), line(r, 'b')];
    const rem = await emp201FieldDrill('co-a', '2026-05-01', '2026-05-31', 'remuneration');
    expect(rem).toMatchObject({ total: 30250.5, rowsTotal: 30250.5, ties: true });
    expect(rem!.rows[0]!.amount).toBe(15250.5);
  });

  it('PAYE and remuneration include directive payments made outside payroll; the others do not', async () => {
    mocks.directives = [{ paymentId: 'p1', directiveNumber: 'D1', employeeName: 'Gone', paymentDate: '2026-05-20', gross: 5000, paye: 1000 }];
    expect(await emp201FieldDrill('co-a', '2026-05-01', '2026-05-31', 'paye')).toMatchObject({ total: 4000, rowsTotal: 4000 });
    expect(await emp201FieldDrill('co-a', '2026-05-01', '2026-05-31', 'remuneration')).toMatchObject({ total: 35000 });
    expect(await emp201FieldDrill('co-a', '2026-05-01', '2026-05-31', 'sdl')).toMatchObject({ total: 200, directivePayments: [] });
  });

  it('a run id outside the declarable runs is null (the route answers 404)', async () => {
    expect(await emp201FieldDrill('co-a', '2026-05-01', '2026-05-31', 'paye', { runId: 'not-a-run' })).toBeNull();
    const one = await emp201FieldDrill('co-a', '2026-05-01', '2026-05-31', 'paye', { runId: 'r1' });
    expect(one).toMatchObject({ rowCount: 2, total: 3000 });
  });

  it('a run with no lines still shows its header total and the gap', async () => {
    mocks.rows = [{ ...run('r1', 5), line_id: null, employee_id: null }];
    const r = await emp201FieldDrill('co-a', '2026-05-01', '2026-05-31', 'paye');
    expect(r).toMatchObject({ total: 3000, rowsTotal: 0, ties: false, rowCount: 0 });
  });

  it('a line whose employee row is missing still counts, non-cash included, on both sides', async () => {
    const r = run('r1', 5);
    mocks.rows = [line(r, 'a', { non_cash: 100, employee_name: '', employee_number: '' }), line(r, 'b')];
    const rem = await emp201FieldDrill('co-a', '2026-05-01', '2026-05-31', 'remuneration');
    expect(rem).toMatchObject({ total: 30100, rowsTotal: 30100, ties: true, rowCount: 2 });
  });

  it('pages at most 200 rows', async () => {
    const r = run('r1', 5);
    mocks.rows = Array.from({ length: 230 }, (_, i) => line(r, `e${i}`, { paye: 1 }));
    const p1 = await emp201FieldDrill('co-a', '2026-05-01', '2026-05-31', 'paye', { pageSize: 9999 });
    expect(p1).toMatchObject({ pageSize: 200, hasMore: true, rowCount: 230 });
    expect(p1!.rows).toHaveLength(200);
    expect((await emp201FieldDrill('co-a', '2026-05-01', '2026-05-31', 'paye', { page: 2, pageSize: 200 }))!.rows).toHaveLength(30);
  });
});
