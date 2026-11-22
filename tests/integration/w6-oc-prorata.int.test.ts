/**
 * Gate ruling 4 on e0eec1dea1: an off-cycle run pays no recurring component (calculation skips them), so approval does
 * not hold it on the regular run's pro-rata rule (runProRataBlocker) either. An allowance effective on the 28th, added
 * after the regular run was approved, does not block the bonus.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { rig, type Route } from './brkr.helpers';
import offCycle from '../../pages/api/payroll/runs/off-cycle';
import amounts from '../../pages/api/payroll/runs/[id]/off-cycle-amounts';
import { runProRataBlocker } from '@/modules/accounting/services/payroll/payrollRecurringProRata';

vi.useFakeTimers({ now: new Date('2026-11-17T08:00:00Z'), shouldAdvanceTime: true, toFake: ['Date'] });

let a: Awaited<ReturnType<typeof rig>>;
let emp = '';
let bonusRun = '';

beforeAll(async () => {
  a = await rig('w6-oc-prorata');
  await a.setup();
  emp = (await a.employee(15_000)).employee;
  const component = (await a.pool.query(`INSERT INTO payroll_components (company_id, name, sars_source_code, component_type)
    VALUES ($1, 'Annual bonus', '3605', 'earning') RETURNING id`, [a.company])).rows[0].id;
  const november = await a.calculatedRun(11);
  expect((await a.api.approve(november)).statusCode).toBe(200);
  const made = await a.call(offCycle as Route, 'POST', '/api/payroll/runs/off-cycle', undefined, {
    body: { month: 11, year: 2026, reason: 'bonus', runDate: '2026-11-25', employees: [{ employeeId: emp, componentId: component, amount: 2_000 }] },
  });
  expect(made.statusCode, JSON.stringify(made.body)).toBe(201);
  bonusRun = String(made.body.data!.id);
  expect((await a.api.calculate(bonusRun)).statusCode).toBe(200);
}, 180_000);

afterAll(async () => {
  await a.pool.query('DELETE FROM payroll_off_cycle_employees WHERE company_id = $1', [a.company]).catch(() => undefined);
  await a.pool.query('DELETE FROM audit_log WHERE company_id = $1', [a.company]).catch(() => undefined);
  await a.teardown();
  vi.useRealTimers();
}, 120_000);

describe('an unchanged bonus amount (gate item 6 on 06c106a94d)', () => {
  it('is a success that leaves the calculated run as it is: its status, lines and totals', async () => {
    const before = (await a.pool.query(`SELECT h.status, h.total_gross::text AS g, (SELECT count(*)::int FROM payroll_run_lines l WHERE l.run_id = h.id) AS n
      FROM payroll_run_headers h WHERE h.id = $1`, [bonusRun])).rows[0];
    expect(before.status).toBe('calculated');
    const res = await a.call(amounts as Route, 'PATCH', `/api/payroll/runs/${bonusRun}/off-cycle-amounts`, bonusRun, {
      body: { employeeId: emp, amount: 2_000, expectedAmount: 2_000 },
    });
    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    const after = (await a.pool.query(`SELECT h.status, h.total_gross::text AS g, (SELECT count(*)::int FROM payroll_run_lines l WHERE l.run_id = h.id) AS n
      FROM payroll_run_headers h WHERE h.id = $1`, [bonusRun])).rows[0];
    expect(after).toEqual(before);
  });
});

describe('a stale expectedAmount (review L2 of e9f437f366)', () => {
  it('is 409 with refusal AMOUNT_CHANGED, and nothing is written', async () => {
    const res = await a.call(amounts as Route, 'PATCH', `/api/payroll/runs/${bonusRun}/off-cycle-amounts`, bonusRun, {
      body: { employeeId: emp, amount: 1_500, expectedAmount: 1_999 },
    });
    expect(res.statusCode).toBe(409);
    expect(res.body.error?.details?.refusal).toBe('AMOUNT_CHANGED');
    expect(Number((await a.pool.query('SELECT amount FROM payroll_off_cycle_employees WHERE run_id = $1', [bonusRun])).rows[0].amount)).toBe(2_000);
  });
});

describe('the pro-rata rule and an off-cycle run', () => {
  it('an allowance effective on the 28th does not block the bonus\'s approval', async () => {
    const allowance = (await a.pool.query(`INSERT INTO payroll_components (company_id, name, sars_source_code, component_type)
      VALUES ($1, 'Cell allowance', '3713', 'earning') RETURNING id`, [a.company])).rows[0].id;
    await a.pool.query(`INSERT INTO payroll_employee_components (employee_id, component_id, amount, effective_from)
      VALUES ($1, $2, 500, '2026-11-28')`, [emp, allowance]);
    expect(await runProRataBlocker(a.company, bonusRun)).toBeNull();
    const ok = await a.api.approve(bonusRun);
    expect(ok.statusCode, JSON.stringify(ok.body)).toBe(200);
  });
});
