/**
 * Wave 6 OC, review #1620 final breaker delta M2: the filed-EMP201 rule holds at calculate and approve, not only at
 * reopen. A paid bonus run is reopened while its month's EMP201 is unfiled; the EMP201 is then filed. The run is not
 * calculated (409) or approved (refused) again, so nothing is approved outside the filed return.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { rig, type Route } from './brkr.helpers';
import offCycle from '../../pages/api/payroll/runs/off-cycle';

vi.useFakeTimers({ now: new Date('2026-11-17T21:15:00Z'), shouldAdvanceTime: true, toFake: ['Date'] });

let a: Awaited<ReturnType<typeof rig>>;
let run = '';

beforeAll(async () => {
  a = await rig('w6-oc-filed');
  await a.setup();
  const mid = (await a.employee(15_000)).employee;
  const bonus = (await a.pool.query(`INSERT INTO payroll_components (company_id, name, sars_source_code, component_type)
    VALUES ($1, 'Annual bonus', '3605', 'earning') RETURNING id`, [a.company])).rows[0].id;
  const regular = await a.calculatedRun(11);
  expect((await a.api.approve(regular)).statusCode).toBe(200);
  const made = await a.call(offCycle as Route, 'POST', '/api/payroll/runs/off-cycle', undefined, {
    body: { month: 11, year: 2026, reason: 'bonus', runDate: '2026-11-17', employees: [{ employeeId: mid, componentId: bonus, amount: 3_000 }] },
  });
  expect(made.statusCode, JSON.stringify(made.body)).toBe(201);
  run = String(made.body.data!.id);
  expect((await a.api.calculate(run)).statusCode).toBe(200);
  expect((await a.api.approve(run)).statusCode).toBe(200);
  vi.setSystemTime(new Date('2026-11-17T22:05:00Z')); // 00:05 SAST, 18 Nov: paid
}, 120_000);

afterAll(async () => {
  const c = await a.pool.connect();
  try { // tax_return_versions refuses DELETE (969): its trigger off and back ON ALWAYS in one transaction
    await c.query('BEGIN');
    await c.query('ALTER TABLE tax_return_versions DISABLE TRIGGER trg_tax_return_versions_immutable');
    await c.query('DELETE FROM tax_return_versions WHERE company_id = $1', [a.company]);
    await c.query('ALTER TABLE tax_return_versions ENABLE ALWAYS TRIGGER trg_tax_return_versions_immutable');
    await c.query('COMMIT');
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally {
    c.release();
  }
  await a.pool.query('DELETE FROM payroll_off_cycle_employees WHERE company_id = $1', [a.company]).catch(() => undefined);
  await a.pool.query('DELETE FROM audit_log WHERE company_id = $1', [a.company]).catch(() => undefined);
  await a.teardown();
  vi.useRealTimers();
}, 120_000);

describe('a filed EMP201 after the reopen', () => {
  it('the reopened run is not calculated (409) or approved again once the month is filed', async () => {
    const journal = String((await a.pool.query('SELECT journal_entry_id FROM payroll_run_headers WHERE id = $1', [run])).rows[0].journal_entry_id);
    expect((await a.api.reopen(run)).statusCode).toBe(200);
    expect((await a.api.reverse(journal)).statusCode).toBe(200);
    await a.pool.query(`INSERT INTO tax_return_versions (company_id, form_type, period_start, period_end, version_no, status, figures,
      posted_through, finalised_by, filed_by, filed_at) VALUES ($1, 'EMP201', '2026-11-01', '2026-11-30', 1, 'filed', '{}'::jsonb, now(), $2, $2, now())`,
    [a.company, a.admin]);
    const calc = await a.api.calculate(run);
    expect(calc.statusCode).toBe(409);
    expect(a.msg(calc)).toMatch(/The EMP201 for 2026-11 is filed, so an off-cycle run of that month is not calculated or approved/);
    const ap = await a.api.approve(run);
    expect(ap.statusCode).not.toBe(200);
    expect(JSON.stringify(ap.body)).toMatch(/The EMP201 for 2026-11 is filed/);
    expect((await a.header(run)).status).toBe('calculated');
  });
});
