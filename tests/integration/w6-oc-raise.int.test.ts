/**
 * Review #1679 M: after its pay date no employee's gross on a reopened off-cycle run rises above what was last
 * approved, on a TERMINATION run as on a bonus run (999x payroll_run_headers.off_cycle_paid_gross, the trigger's
 * snapshot as the run left 'approved'; payrollOffCycleCorrection). One month holds a bonus (paid 16 Nov) and a
 * termination run (paid 17 Nov); on the 18th both are reopened and raised: approval refuses each, a correction down
 * is approved.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { rig, type Route } from './brkr.helpers';
import offCycle from '../../pages/api/payroll/runs/off-cycle';
import amounts from '../../pages/api/payroll/runs/[id]/off-cycle-amounts';

vi.useFakeTimers({ now: new Date('2026-11-15T21:15:00Z'), shouldAdvanceTime: true, toFake: ['Date'] }); // 23:15 SAST, 16 Nov

let a: Awaited<ReturnType<typeof rig>>;
let mid = '';
let young = '';
let bonusComponent = '';
let bonus = '';
let term = '';

const create = (body: Record<string, unknown>) =>
  a.call(offCycle as Route, 'POST', '/api/payroll/runs/off-cycle', undefined, { body: { month: 11, year: 2026, ...body } });
const gross = async (id: string, who: string) =>
  Number((await a.pool.query('SELECT gross_pay::float8 AS g FROM payroll_run_lines WHERE run_id = $1 AND employee_id = $2', [id, who])).rows[0]?.g ?? 0);
const journalOf = async (id: string) => String((await a.pool.query('SELECT journal_entry_id FROM payroll_run_headers WHERE id = $1', [id])).rows[0].journal_entry_id);
/** Move the clock and mint fresh sessions (they last an hour). */
async function at(iso: string): Promise<void> {
  vi.setSystemTime(new Date(iso));
  for (const u of [a.admin, a.approver]) a.tokens[u] = await a.mint(u);
}
async function final(made: { statusCode: number; body: { data?: { id?: unknown } } }): Promise<string> {
  expect(made.statusCode, JSON.stringify(made.body)).toBe(201);
  const id = String(made.body.data!.id);
  expect((await a.api.calculate(id)).statusCode).toBe(200);
  const ok = await a.api.approve(id);
  expect(ok.statusCode, JSON.stringify(ok.body)).toBe(200);
  return id;
}

beforeAll(async () => {
  a = await rig('w6-oc-raise');
  await a.setup();
  mid = (await a.employee(15_000)).employee;
  young = (await a.employee(9_000)).employee;
  bonusComponent = (await a.pool.query(`INSERT INTO payroll_components (company_id, name, sars_source_code, component_type)
    VALUES ($1, 'Annual bonus', '3605', 'earning') RETURNING id`, [a.company])).rows[0].id;
  const regular = await a.calculatedRun(11);
  expect((await a.api.approve(regular)).statusCode).toBe(200);
  bonus = await final(await create({ reason: 'bonus', runDate: '2026-11-16', employees: [{ employeeId: young, componentId: bonusComponent, amount: 5_000 }] }));
  await at('2026-11-16T21:30:00Z'); // 23:30 SAST, 17 Nov
  await a.pool.query(`UPDATE payroll_employees SET end_date = '2026-11-16', termination_reason = 'resignation',
    termination_notice_period_days = 10, termination_served_notice_days = 0, termination_include_leave_payout = false WHERE id = $1`, [mid]);
  term = await final(await create({ reason: 'termination', runDate: '2026-11-17', employees: [{ employeeId: mid }] }));
  await at('2026-11-17T22:05:00Z'); // 00:05 SAST, 18 Nov: both paid
}, 180_000);

afterAll(async () => {
  await a.pool.query('DELETE FROM payroll_off_cycle_employees WHERE company_id = $1', [a.company]).catch(() => undefined);
  await a.pool.query('DELETE FROM audit_log WHERE company_id = $1', [a.company]).catch(() => undefined);
  await a.teardown();
  vi.useRealTimers();
}, 120_000);

describe('a paid off-cycle run is not raised after its pay date (bonus and termination)', () => {
  it('termination: notice days 10 -> 60 after the pay date is refused at approval; back to 10 is approved', async () => {
    const paid = await gross(term, mid);
    expect((await a.api.reopen(term)).statusCode).toBe(200);
    expect((await a.pool.query('SELECT off_cycle_paid_gross AS s FROM payroll_run_headers WHERE id = $1', [term])).rows[0].s).toEqual({ [mid]: paid });
    expect((await a.api.reverse(await journalOf(term))).statusCode).toBe(200);
    await a.pool.query('UPDATE payroll_employees SET termination_notice_period_days = 60 WHERE id = $1', [mid]);
    expect((await a.api.calculate(term)).statusCode).toBe(200);
    expect(await gross(term, mid)).toBeGreaterThan(paid);
    const refused = await a.api.approve(term);
    expect(refused.statusCode).not.toBe(200);
    expect(JSON.stringify(refused.body)).toMatch(/can't be raised after the pay date .*Pay the difference in a new off-cycle run/);
    expect((await a.header(term)).status).toBe('calculated');
    // The approval preview (the MCP dry run's gate) refuses it too.
    expect(JSON.stringify((await a.api.preview(term)).body)).toMatch(/can't be raised after the pay date/);
    await a.pool.query('UPDATE payroll_employees SET termination_notice_period_days = 10 WHERE id = $1', [mid]);
    expect((await a.api.calculate(term)).statusCode).toBe(200);
    const ok = await a.api.approve(term);
    expect(ok.statusCode, JSON.stringify(ok.body)).toBe(200);
    expect(await gross(term, mid)).toBeCloseTo(paid, 2);
  });

  it('bonus in the same month: a raise is refused at the edit and at approval; lowering it is approved', async () => {
    // The termination run is later in the month and final: reopen it first, then the bonus.
    expect((await a.api.reopen(term)).statusCode).toBe(200);
    expect((await a.api.reverse(await journalOf(term))).statusCode).toBe(200);
    expect((await a.api.reopen(bonus)).statusCode).toBe(200);
    expect((await a.api.reverse(await journalOf(bonus))).statusCode).toBe(200);
    const up = await a.call(amounts as Route, 'PATCH', `/api/payroll/runs/${bonus}/off-cycle-amounts`, bonus, { body: { employeeId: young, amount: 6_000 } });
    expect(up.statusCode).toBe(409);
    expect((await a.call(amounts as Route, 'PATCH', `/api/payroll/runs/${bonus}/off-cycle-amounts`, bonus, { body: { employeeId: young, amount: 4_000 } })).statusCode).toBe(200);
    await a.pool.query('UPDATE payroll_off_cycle_employees SET amount = 9000 WHERE run_id = $1', [bonus]); // raised below the service (draft)
    expect((await a.api.calculate(bonus)).statusCode).toBe(200);
    expect((await a.api.approve(bonus)).statusCode).not.toBe(200);
    expect((await a.call(amounts as Route, 'PATCH', `/api/payroll/runs/${bonus}/off-cycle-amounts`, bonus, { body: { employeeId: young, amount: 4_000 } })).statusCode).toBe(200);
    expect((await a.api.calculate(bonus)).statusCode).toBe(200);
    expect((await a.api.approve(bonus)).statusCode).toBe(200);
    expect(await gross(bonus, young)).toBe(4_000);
    expect((await a.api.calculate(term)).statusCode).toBe(200);
    expect((await a.api.approve(term)).statusCode).toBe(200);
  });
});
