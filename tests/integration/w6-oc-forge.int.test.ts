/**
 * Review #1679c (b): the paid-gross snapshot lost below the service. As app_user, a reopened, paid bonus run's header
 * is deleted and inserted again with its id and approval_history: the snapshot comes back NULL (the trigger never
 * takes one on insert). The cap fails closed: a run approved before with no snapshot caps every employee at nil, so
 * R80 000 is refused at approval after the pay date. (Wiping approval_history instead brings back D1's pay-date
 * refusal.) A legitimate reopen of the paid run, with its lines, always takes a snapshot.
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

describe('a lost snapshot fails closed', () => {
  it('a paid run re-inserted with its approval_history and no snapshot is capped at nil: R80 000 refused at approval', async () => {
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
    // Below the service, as app_user: the header deleted and inserted again with its id and approval history.
    const h = (await a.pool.query('SELECT approval_history::text AS hist, reopened_at, created_by FROM payroll_run_headers WHERE id = $1', [id])).rows[0];
    await asApp('DELETE FROM payroll_run_headers WHERE id = $1', [id]);
    const back = await asApp(`INSERT INTO payroll_run_headers (id, company_id, period_month, period_year, pay_frequency, run_kind, off_cycle_reason,
      period_start, period_end, run_date, approval_history, reopened_at, created_by)
      VALUES ($1, $2, 11, 2026, 'monthly', 'off_cycle', 'bonus', '2026-11-01', '2026-11-30', '2026-11-17', $3::tstzmultirange, $4, $5)
      RETURNING off_cycle_paid_gross`, [id, a.company, h.hist, h.reopened_at, h.created_by]) as Array<{ off_cycle_paid_gross: unknown }>;
    expect(back[0]!.off_cycle_paid_gross).toBeNull();
    await asApp('INSERT INTO payroll_off_cycle_employees (company_id, run_id, employee_id, component_id, amount) VALUES ($1, $2, $3, $4, 80000)',
      [a.company, id, mid, bonusComponent]);
    expect((await a.api.calculate(id)).statusCode).toBe(200);
    const ap = await a.api.approve(id);
    expect(ap.statusCode).not.toBe(200);
    expect(JSON.stringify(ap.body)).toMatch(/can't be raised after the pay date \(last approved R\s0\.00\)/);
    expect((await a.header(id)).status).toBe('calculated');
  });
});
