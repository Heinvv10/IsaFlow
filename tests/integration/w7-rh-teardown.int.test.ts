/**
 * Wave 7 RH (migration 1054): the teardown paths still work beside the new DELETE rules.
 *  - the Demo reseed's wipe path (reopenFinalRuns, then the plan's DELETE steps) still empties the Demo's runs as a
 *    NOSUPERUSER role (production's reseed role is postgres, NOSUPERUSER), runs approved before included (the Demo
 *    is exempt from the evidence rule only, as 999x's history guard exempts it); without the reopen it is refused
 *    (the final rule binds the Demo);
 *  - a company delete still cascades its final run (coordinator ruling B: pg_trigger_depth() > 1), while a direct
 *    delete of that run is refused.
 * Everything runs in a transaction that is rolled back; seeding as the fixture's superuser.
 */
import { afterAll, describe, expect, it } from 'vitest';
import pg, { Pool } from 'pg';
import { reopenFinalRuns } from '../../scripts/lib/demoReseed/payrollFinal';
import { txOver } from '../../scripts/lib/demoReseed/db';
import { WIPE_STEPS, deleteSql } from '../../scripts/lib/demoReseed/wipePlan';

const su = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const DEMO = '00000000-0000-0000-0000-000000000001';
const YEAR = 2100 + Math.floor(Math.random() * 800);
const FINAL_REFUSED = /a final pay run is not deleted \(reopen or cancel it first\)/;

afterAll(async () => { await su.end(); });

/** A calculated header of `company`, then `status` with `stamp` if given, on `db`. */
async function header(company: string, status: string, stamp: 'approved_at' | null, month: number,
  db: { query: Pool['query'] }): Promise<string> {
  const id = (await db.query(`INSERT INTO payroll_run_headers (company_id, period_month, period_year, status, run_date,
      total_gross, total_paye, total_net, employee_count)
    VALUES ($1, $2, $3, 'calculated', make_date($3, $2, 28), 10000, 2000, 8000, 1) RETURNING id`, [company, month, YEAR])).rows[0].id as string;
  if (status !== 'calculated') {
    await db.query(`UPDATE payroll_run_headers SET status = $2${stamp ? `, ${stamp} = now()` : ''} WHERE id = $1`, [id, status]);
  }
  return id;
}

describe('teardown paths still work', () => {
  it('the Demo reseed wipe: reopenFinalRuns, then the plan\'s DELETE steps, as a non-superuser', async () => {
    const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query(`INSERT INTO companies (id, name, is_demo) VALUES ($1, 'ISAFlow Demo (Pty) Ltd', true) ON CONFLICT (id) DO NOTHING`, [DEMO]);
      const emp = (await c.query(`INSERT INTO payroll_employees (company_id, employee_number, first_name, last_name, start_date)
        VALUES ($1, $2, 'Demo', 'Person', '2020-01-01') RETURNING id`, [DEMO, `RH-${YEAR}`])).rows[0].id as string;
      const db = { query: c.query.bind(c) } as unknown as Pool;
      const fin = await header(DEMO, 'calculated', null, 9, db);
      await c.query('INSERT INTO payroll_run_lines (run_id, employee_id, gross_pay, net_pay) VALUES ($1, $2, 10000, 8000)', [fin, emp]);
      await c.query(`UPDATE payroll_run_headers SET status = 'approved', approved_at = now() WHERE id = $1`, [fin]);
      // A reopened run keeps approval_history (999x): it is not final, and the history guard exempts the Demo.
      const reopened = await header(DEMO, 'calculated', null, 10, db);
      await c.query(`UPDATE payroll_run_headers SET approval_history = tstzmultirange(tstzrange(now() - interval '2 days', now()))
        WHERE id = $1`, [reopened]);
      await c.query('SET LOCAL ROLE platform_admin'); // NOSUPERUSER, as production's reseed role is
      const steps = WIPE_STEPS.filter((s) => ['payroll_run_lines', 'payroll_run_headers'].includes(s.table));
      expect(steps.map((s) => s.table)).toEqual(['payroll_run_lines', 'payroll_run_headers']);
      // Without the reopen the wipe is refused: the Demo has no exemption.
      await c.query('SAVEPOINT w');
      await expect((async () => { for (const s of steps) await c.query(deleteSql(s), [DEMO]); })()).rejects.toThrow(/final pay run/);
      await c.query('ROLLBACK TO SAVEPOINT w');
      expect(await reopenFinalRuns(txOver(c), DEMO)).toBeGreaterThanOrEqual(1);
      for (const s of steps) await c.query(deleteSql(s), [DEMO]);
      expect((await c.query('SELECT count(*)::int AS n FROM payroll_run_headers WHERE company_id = $1', [DEMO])).rows[0].n).toBe(0);
    } finally {
      await c.query('ROLLBACK');
      await c.end();
    }
  });
  it('a company delete still cascades its final run (coordinator ruling B), while a direct delete of it is refused', async () => {
    const c = await su.connect();
    try {
      await c.query('BEGIN');
      const co = (await c.query("INSERT INTO companies (name) VALUES ('RH cascade') RETURNING id")).rows[0].id as string;
      const h = await header(co, 'approved', 'approved_at', 11, c as unknown as Pool);
      await c.query('SET LOCAL ROLE platform_admin');
      await c.query('SAVEPOINT d');
      await expect(c.query('DELETE FROM payroll_run_headers WHERE id = $1', [h])).rejects.toThrow(FINAL_REFUSED);
      await c.query('ROLLBACK TO SAVEPOINT d');
      expect((await c.query('DELETE FROM companies WHERE id = $1 RETURNING id', [co])).rows).toEqual([{ id: co }]);
      expect((await c.query('SELECT count(*)::int AS n FROM payroll_run_headers WHERE id = $1', [h])).rows[0].n).toBe(0);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });
});
