/**
 * Gate review of 7630d9379f, ruling 3: an off-cycle run is not reopened while a LATER month of its tax year has a final
 * run. Reopening it would take it out of the month's final totals, and the later-month guard then refuses its
 * recalculation and approval, so it would be stranded. Refused (409) before anything changes: the run stays approved.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { rig, type Route } from './brkr.helpers';
import offCycle from '../../pages/api/payroll/runs/off-cycle';

vi.useFakeTimers({ now: new Date('2026-11-17T08:00:00Z'), shouldAdvanceTime: true, toFake: ['Date'] });

let a: Awaited<ReturnType<typeof rig>>;
let bonusRun = '';

beforeAll(async () => {
  a = await rig('w6-oc-later');
  await a.setup();
  const emp = (await a.employee(15_000)).employee;
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
  const ok = await a.api.approve(bonusRun);
  expect(ok.statusCode, JSON.stringify(ok.body)).toBe(200);
  const december = await a.calculatedRun(12);
  const dec = await a.api.approve(december);
  expect(dec.statusCode, JSON.stringify(dec.body)).toBe(200);
}, 180_000);

afterAll(async () => {
  await a.pool.query('DELETE FROM payroll_off_cycle_employees WHERE company_id = $1', [a.company]).catch(() => undefined);
  await a.pool.query('DELETE FROM audit_log WHERE company_id = $1', [a.company]).catch(() => undefined);
  await a.teardown();
  vi.useRealTimers();
}, 120_000);

describe('reopen with a later month final', () => {
  it('a November bonus is not reopened while December\'s run is approved: 409, still approved', async () => {
    const re = await a.api.reopen(bonusRun);
    expect(re.statusCode).toBe(409);
    expect(a.msg(re)).toMatch(/December 2026's run is approved/);
    expect((await a.header(bonusRun)).status).toBe('approved');
  });
});
