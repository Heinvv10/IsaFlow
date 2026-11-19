/**
 * Reviews #1679c and #1679d, the delete/re-insert class: a header's approval history is never removed or invented
 * below the service.
 *  - As app_user, a header approved before is not deleted, and no header is inserted with an approval history or a
 *    final status (999x payroll_run_headers_history_guard).
 *  - The state that class aimed at (approval history, no snapshot), made here as an exempt superuser, still fails
 *    closed: the cap is nil for every employee in TS (paidCaps), and the snapshot trigger takes nil for every employee
 *    when app_user flips the run through 'approved' over raised lines. R80 000 is refused at approval after the pay date.
 *  - A legitimate reopen of the paid run, with its lines, always takes a snapshot.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { rig, type Route } from './brkr.helpers';
import offCycle from '../../pages/api/payroll/runs/off-cycle';

vi.useFakeTimers({ now: new Date('2026-11-17T21:15:00Z'), shouldAdvanceTime: true, toFake: ['Date'] });

let a: Awaited<ReturnType<typeof rig>>;
let mid = '';
let bonusComponent = '';

async function asApp(text: string, params: unknown[] = []): Promise<unknown[]> {
  const c = await a.pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE app_user');
    await c.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: a.admin, role: 'authenticated', aal: 'aal2' })]);
    await c.query("SELECT set_config('app.current_company_id', $1, true)", [a.company]);
    const r = await c.query(text, params);
    await c.query('COMMIT');
    return r.rows;
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally {
    c.release();
  }
}

beforeAll(async () => {
  a = await rig('w6-oc-forge');
  await a.setup();
  mid = (await a.employee(15_000)).employee;
  bonusComponent = (await a.pool.query(`INSERT INTO payroll_components (company_id, name, sars_source_code, component_type)
    VALUES ($1, 'Annual bonus', '3605', 'earning') RETURNING id`, [a.company])).rows[0].id;
  const regular = await a.calculatedRun(11);
  expect((await a.api.approve(regular)).statusCode).toBe(200);
}, 120_000);

afterAll(async () => {
  await a.pool.query('DELETE FROM payroll_off_cycle_employees WHERE company_id = $1', [a.company]).catch(() => undefined);
  await a.pool.query('DELETE FROM audit_log WHERE company_id = $1', [a.company]).catch(() => undefined);
  await a.teardown();
  vi.useRealTimers();
}, 120_000);

describe('the approval history is never removed or invented below the service', () => {
  it('app_user cannot delete a reopened run or insert history; a lost snapshot fails closed (TS and trigger)', async () => {
    const made = await a.call(offCycle as Route, 'POST', '/api/payroll/runs/off-cycle', undefined, {
      body: { month: 11, year: 2026, reason: 'bonus', runDate: '2026-11-17', employees: [{ employeeId: mid, componentId: bonusComponent, amount: 5_000 }] },
    });
    expect(made.statusCode, JSON.stringify(made.body)).toBe(201);
    const id = String(made.body.data!.id);
    expect((await a.api.calculate(id)).statusCode).toBe(200);
    expect((await a.api.approve(id)).statusCode).toBe(200);
    vi.setSystemTime(new Date('2026-11-17T22:05:00Z')); // 00:05 SAST, 18 Nov: paid
    const journal = String((await a.pool.query('SELECT journal_entry_id FROM payroll_run_headers WHERE id = $1', [id])).rows[0].journal_entry_id);
    expect((await a.api.reopen(id)).statusCode).toBe(200);
    // The legitimate reopen of a paid run with lines takes a snapshot, so a real correction is never capped at nil.
    expect((await a.pool.query('SELECT off_cycle_paid_gross AS s FROM payroll_run_headers WHERE id = $1', [id])).rows[0].s).toEqual({ [mid]: 5_000 });
    expect((await a.api.reverse(journal)).statusCode).toBe(200);
    const h = (await a.pool.query('SELECT approval_history::text AS hist, reopened_at, created_by FROM payroll_run_headers WHERE id = $1', [id])).rows[0];

    // (i) As app_user: no delete of a run approved before; no insert carrying history or a final status.
    await expect(asApp('DELETE FROM payroll_run_headers WHERE id = $1', [id]))
      .rejects.toThrow(/a pay run that was approved before is not deleted; cancel it instead/);
    const reinsert = (status: string, hist: string | null) => asApp(`INSERT INTO payroll_run_headers (company_id, period_month, period_year,
      pay_frequency, run_kind, off_cycle_reason, period_start, period_end, run_date, status, approval_history)
      VALUES ($1, 12, 2026, 'monthly', 'off_cycle', 'bonus', '2026-12-01', '2026-12-31', '2026-12-29', $2, $3::tstzmultirange)`, [a.company, status, hist]);
    await expect(reinsert('draft', h.hist)).rejects.toThrow(/a new pay run starts without an approval history and is not final/);
    await expect(reinsert('approved', null)).rejects.toThrow(/a new pay run starts without an approval history and is not final/);

    // (ii) The state the class aimed at, made by an exempt superuser: history, no snapshot, R80 000 of lines.
    await a.pool.query('DELETE FROM payroll_run_headers WHERE id = $1', [id]);
    await a.pool.query(`INSERT INTO payroll_run_headers (id, company_id, period_month, period_year, pay_frequency, run_kind, off_cycle_reason,
      period_start, period_end, run_date, approval_history, reopened_at, created_by)
      VALUES ($1, $2, 11, 2026, 'monthly', 'off_cycle', 'bonus', '2026-11-01', '2026-11-30', '2026-11-17', $3::tstzmultirange, $4, $5)`,
    [id, a.company, h.hist, h.reopened_at, h.created_by]);
    expect((await a.pool.query('SELECT off_cycle_paid_gross AS s FROM payroll_run_headers WHERE id = $1', [id])).rows[0].s).toBeNull();
    await asApp('INSERT INTO payroll_off_cycle_employees (company_id, run_id, employee_id, component_id, amount) VALUES ($1, $2, $3, $4, 80000)',
      [a.company, id, mid, bonusComponent]);
    expect((await a.api.calculate(id)).statusCode).toBe(200);
    // TS fails closed: capped at nil.
    const ap = await a.api.approve(id);
    expect(ap.statusCode).not.toBe(200);
    expect(JSON.stringify(ap.body)).toMatch(/can't be raised after the pay date \(last approved R\s0\.00\)/);
    // The trigger fails closed too: app_user flips the run through 'approved' over the raised lines; the first snapshot
    // of a run with history takes nil for every employee, and approval still refuses.
    for (const status of ['approved', 'calculated']) await asApp('UPDATE payroll_run_headers SET status = $2 WHERE id = $1', [id, status]);
    expect((await a.pool.query('SELECT off_cycle_paid_gross AS s FROM payroll_run_headers WHERE id = $1', [id])).rows[0].s).toEqual({ [mid]: 0 });
    const flipped = await a.api.approve(id);
    expect(flipped.statusCode).not.toBe(200);
    expect(JSON.stringify(flipped.body)).toMatch(/can't be raised after the pay date \(last approved R\s0\.00\)/);
    expect((await a.header(id)).status).toBe('calculated');
  });
});
