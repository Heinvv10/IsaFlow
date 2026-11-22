/**
 * Gate item 2 on 06c106a94d: a bonus is costed on the employee's line of the month's final regular run, so its
 * calculation re-checks that line exists, not only its creation. The regular run reopened and recalculated without the
 * employee while the bonus is a draft: the bonus calculation is refused (409 REGULAR_LINE_MISSING, naming them), never
 * costed on an empty month.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { rig, type Route } from './brkr.helpers';
import offCycle from '../../pages/api/payroll/runs/off-cycle';

vi.useFakeTimers({ now: new Date('2026-11-17T08:00:00Z'), shouldAdvanceTime: true, toFake: ['Date'] });

let a: Awaited<ReturnType<typeof rig>>;
let emp = '';
let regular = '';
let bonusRun = '';

beforeAll(async () => {
  a = await rig('w6-oc-regline');
  await a.setup();
  emp = (await a.employee(15_000)).employee;
  await a.employee(12_000); // the regular run keeps another employee
  const component = (await a.pool.query(`INSERT INTO payroll_components (company_id, name, sars_source_code, component_type)
    VALUES ($1, 'Annual bonus', '3605', 'earning') RETURNING id`, [a.company])).rows[0].id;
  regular = await a.calculatedRun(11);
  expect((await a.api.approve(regular)).statusCode).toBe(200);
  const made = await a.call(offCycle as Route, 'POST', '/api/payroll/runs/off-cycle', undefined, {
    body: { month: 11, year: 2026, reason: 'bonus', runDate: '2026-11-25', employees: [{ employeeId: emp, componentId: component, amount: 2_000 }] },
  });
  expect(made.statusCode, JSON.stringify(made.body)).toBe(201);
  bonusRun = String(made.body.data!.id);
}, 180_000);

afterAll(async () => {
  await a.pool.query('DELETE FROM payroll_off_cycle_employees WHERE company_id = $1', [a.company]).catch(() => undefined);
  await a.pool.query('DELETE FROM audit_log WHERE company_id = $1', [a.company]).catch(() => undefined);
  await a.teardown();
  vi.useRealTimers();
}, 120_000);

describe('the bonus employee\'s regular line', () => {
  it('gone from the recalculated regular run: the bonus calculation is refused, naming them', async () => {
    const journal = String((await a.pool.query('SELECT journal_entry_id FROM payroll_run_headers WHERE id = $1', [regular])).rows[0].journal_entry_id);
    expect((await a.api.reopen(regular)).statusCode).toBe(200);
    expect((await a.api.reverse(journal)).statusCode).toBe(200);
    // Left before November: the recalculated regular run no longer pays them.
    await a.pool.query(`UPDATE payroll_employees SET end_date = '2026-10-31', termination_reason = 'resignation' WHERE id = $1`, [emp]);
    expect((await a.api.calculate(regular)).statusCode).toBe(200);
    expect(Number((await a.pool.query('SELECT count(*)::int AS n FROM payroll_run_lines WHERE run_id = $1 AND employee_id = $2', [regular, emp])).rows[0].n)).toBe(0);
    expect((await a.api.approve(regular)).statusCode).toBe(200);
    const number = (await a.pool.query('SELECT employee_number AS n FROM payroll_employees WHERE id = $1', [emp])).rows[0].n;
    const calc = await a.api.calculate(bonusRun);
    expect(calc.statusCode).toBe(409);
    expect(calc.body.error?.details?.refusal).toBe('REGULAR_LINE_MISSING');
    expect(a.msg(calc)).toContain(`(${number})`);
    expect(Number((await a.pool.query('SELECT count(*)::int AS n FROM payroll_run_lines WHERE run_id = $1', [bonusRun])).rows[0].n)).toBe(0);
  });
});
