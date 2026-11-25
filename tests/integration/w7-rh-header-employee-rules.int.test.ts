/**
 * Wave 7 RH (migration 1054): pay run header DELETE rules and a fixed employee company (W9, W10, W35).
 *  - payroll_run_headers and payroll_employees: one app_user policy per command; a user of two companies, with A
 *    active, cannot delete, update or move B's rows (W9);
 *  - payroll_employees.company_id never changes for a non-superuser, BYPASSRLS roles included (W10);
 *  - a FINAL header (approved/paid with approved_at or approval_grandfathered_at) is not deleted by a direct DELETE,
 *    for app_user and platform_admin alike; nor, outside the Demo, is one with past-approval evidence (ever_final_at,
 *    which the trigger keeps and no statement clears, reopened_at, a stamp or approval_history), so no run that was
 *    approved can be deleted and inserted again with its off-cycle snapshot reset (W35); a never-final draft deletes;
 *  - the Demo reseed's wipe path (reopenFinalRuns, then the plan's DELETE steps) still empties the Demo's runs, as a
 *    non-superuser, runs that were approved before included (the Demo is exempt from the evidence rule only, as 999x's
 *    history guard exempts it); without the reopen it is refused (the final rule binds the Demo);
 *  - a company delete still cascades its final runs (coordinator ruling B: pg_trigger_depth() > 1), and companies is
 *    the only parent that cascades into payroll_run_headers.
 * Seeding runs as the fixture's superuser (exempt); every refused statement is followed by a check that no row moved.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg, { Pool, type PoolClient } from 'pg';
import { reopenFinalRuns } from '../../scripts/lib/demoReseed/payrollFinal';
import { txOver } from '../../scripts/lib/demoReseed/db';
import { WIPE_STEPS, deleteSql } from '../../scripts/lib/demoReseed/wipePlan';

const su = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const DEMO = '00000000-0000-0000-0000-000000000001';
const [A, B, UA, UAB] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
const [EA, EB] = [crypto.randomUUID(), crypto.randomUUID()];
const YEAR = 2100 + Math.floor(Math.random() * 800);
const FINAL_REFUSED = /a final pay run is not deleted \(reopen or cancel it first\)/;
const MOVE_REFUSED = /an employee's company is fixed/;
// The same words as 999x's history guard, which this rule widens (its pins in w6-oc-forge hold).
const EVIDENCE_REFUSED = /a pay run that was approved before is not deleted; cancel it instead/;

const one = async (q: string, p: unknown[] = []) => (await su.query(q, p)).rows[0];
/** A header of `company` in `status`; final ones get their stamp after a line, as the app writes them. */
async function header(company: string, status: string, stamp: 'approved_at' | 'approval_grandfathered_at' | null = null,
  month = 3, db: { query: Pool['query'] } = su): Promise<string> {
  const id = (await db.query(`INSERT INTO payroll_run_headers (company_id, period_month, period_year, status, run_date,
      total_gross, total_paye, total_net, employee_count)
    VALUES ($1, $2, $3, 'calculated', make_date($3, $2, 28), 10000, 2000, 8000, 1) RETURNING id`, [company, month, YEAR])).rows[0].id as string;
  if (status !== 'calculated') {
    await db.query(`UPDATE payroll_run_headers SET status = $2${stamp ? `, ${stamp} = now()` : ''} WHERE id = $1`, [id, status]);
  }
  return id;
}
const exists = async (id: string) => (await one('SELECT count(*)::int AS n FROM payroll_run_headers WHERE id = $1', [id])).n === 1;

beforeAll(async () => {
  await su.query("INSERT INTO companies (id, name) VALUES ($1, 'RH A'), ($2, 'RH B')", [A, B]);
  await su.query('INSERT INTO users (id, email) VALUES ($1, $3), ($2, $4)',
    [UA, UAB, `${UA}@example.invalid`, `${UAB}@example.invalid`]);
  await su.query(`INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $3, 'admin'), ($1, $4, 'admin'), ($2, $4, 'admin')`,
    [A, B, UA, UAB]);
  await su.query(`INSERT INTO payroll_employees (id, company_id, employee_number, first_name, last_name, start_date) VALUES
    ($1, $3, 'RH-A', 'Ann', 'A', '2025-01-01'), ($2, $4, 'RH-B', 'Ben', 'B', '2025-01-01')`, [EA, EB, A, B]);
}, 60_000);

afterAll(async () => {
  try {
    await su.query('DELETE FROM payroll_run_headers WHERE company_id = ANY($1)', [[A, B]]);
    await su.query('DELETE FROM payroll_employees WHERE company_id = ANY($1)', [[A, B]]);
    await su.query('DELETE FROM company_users WHERE company_id = ANY($1)', [[A, B]]);
    await su.query('DELETE FROM companies WHERE id = ANY($1)', [[A, B]]);
    await su.query('DELETE FROM users WHERE id = ANY($1)', [[UA, UAB]]);
  } finally { await su.end(); }
});

type Who = { role: 'app_user' | 'platform_admin'; user?: string; company?: string };
/** `fn` in one transaction as `who` (withAuth's role and claims for app_user), always rolled back. */
async function as<T>(who: Who, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await su.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SET LOCAL ROLE ${who.role}`);
    if (who.user) await c.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: who.user, role: 'authenticated' })]);
    if (who.company) await c.query("SELECT set_config('app.current_company_id', $1, true)", [who.company]);
    return await fn(c);
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
}
const dual = { role: 'app_user' as const, user: UAB, company: A };
const owner = { role: 'app_user' as const, user: UA, company: A };
const admin = { role: 'platform_admin' as const };
const n = async (c: PoolClient, q: string, p: unknown[]) => (await c.query(q, p)).rowCount;

describe('1054: the catalogue', () => {
  it('each table has one app_user policy per command and the two triggers are ENABLE ALWAYS', async () => {
    for (const t of ['payroll_run_headers', 'payroll_employees']) {
      const pols = (await su.query(`SELECT policyname, cmd FROM pg_policies WHERE schemaname = 'public' AND tablename = $1
        AND roles && ARRAY['app_user', 'public']::name[] ORDER BY policyname`, [t])).rows;
      expect(pols).toEqual([
        { policyname: 'tenant_isolation_delete', cmd: 'DELETE' }, { policyname: 'tenant_isolation_insert', cmd: 'INSERT' },
        { policyname: 'tenant_isolation_select', cmd: 'SELECT' }, { policyname: 'tenant_isolation_update', cmd: 'UPDATE' }]);
    }
    const trg = (await su.query(`SELECT tgname, tgenabled FROM pg_trigger WHERE tgname IN
      ('payroll_run_headers_final_no_delete', 'payroll_employees_company_fixed') ORDER BY 1`)).rows;
    expect(trg).toEqual([{ tgname: 'payroll_employees_company_fixed', tgenabled: 'A' },
      { tgname: 'payroll_run_headers_final_no_delete', tgenabled: 'A' }]);
  });
  it('companies is the only parent whose delete cascades into payroll_run_headers (the cascade exemption\'s census)', async () => {
    const fks = (await su.query(`SELECT confrelid::regclass::text AS parent, confdeltype AS del FROM pg_constraint
      WHERE conrelid = 'public.payroll_run_headers'::regclass AND contype = 'f' AND confdeltype = 'c'`)).rows;
    expect(fks).toEqual([{ parent: 'companies', del: 'c' }]);
    expect((await one(`SELECT has_table_privilege('app_user', 'public.companies', 'DELETE') AS d`)).d).toBe(false);
    const deleters = (await su.query(`SELECT p.proname FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace
      WHERE s.nspname NOT IN ('pg_catalog', 'information_schema') AND p.prosrc ~* 'delete\\s+from\\s+(public\\.)?payroll_run_headers'`)).rows;
    expect(deleters).toEqual([]);
  });
});

describe('W9: a user of two companies acts only in the active one', () => {
  it('cannot delete or update B\'s header with A active, and B\'s header is untouched', async () => {
    const hb = await header(B, 'draft');
    const ha = await header(A, 'draft', null, 4);
    await as(dual, async (c) => {
      expect((await c.query('SELECT id FROM payroll_run_headers WHERE id = $1', [hb])).rows).toHaveLength(1); // still reads it
      expect(await n(c, 'DELETE FROM payroll_run_headers WHERE id = $1', [hb])).toBe(0);
      expect(await n(c, "UPDATE payroll_run_headers SET notes = 'x' WHERE id = $1", [hb])).toBe(0);
      expect(await n(c, 'DELETE FROM payroll_run_headers WHERE id = $1', [ha])).toBe(1); // the active company's draft goes
    });
    expect(await exists(hb)).toBe(true);
  });
  it('cannot delete B\'s employee, and cannot insert a header for B', async () => {
    await as(dual, async (c) => {
      expect(await n(c, 'DELETE FROM payroll_employees WHERE id = $1', [EB])).toBe(0);
      await expect(c.query(`INSERT INTO payroll_run_headers (company_id, period_month, period_year, status)
        VALUES ($1, 5, $2, 'draft')`, [B, YEAR])).rejects.toMatchObject({ code: '42501' });
    });
    expect((await one('SELECT company_id FROM payroll_employees WHERE id = $1', [EB])).company_id).toBe(B);
  });
});

describe('W10: an employee\'s company is fixed', () => {
  it('the dual member cannot move B\'s employee into A, nor A\'s into B', async () => {
    await as(dual, async (c) => {
      expect(await n(c, 'UPDATE payroll_employees SET company_id = $2 WHERE id = $1', [EB, A])).toBe(0);
      await expect(c.query('UPDATE payroll_employees SET company_id = $2 WHERE id = $1', [EA, B])).rejects.toThrow(MOVE_REFUSED);
    });
  });
  it('platform_admin (BYPASSRLS) is refused too, and the employee stays where it was', async () => {
    await as(admin, async (c) => {
      await expect(c.query('UPDATE payroll_employees SET company_id = $2 WHERE id = $1', [EB, A])).rejects
        .toMatchObject({ code: '23514', message: expect.stringMatching(MOVE_REFUSED) });
    });
    expect((await one('SELECT company_id FROM payroll_employees WHERE id = $1', [EB])).company_id).toBe(B);
  });
  it('other employee fields still update', async () => {
    await as(owner, async (c) => {
      expect(await n(c, "UPDATE payroll_employees SET first_name = 'Anna', company_id = company_id WHERE id = $1", [EA])).toBe(1);
    });
  });
});

describe('W35: a final header is not deleted', () => {
  it.each([
    ['approved', 'approved_at'], ['paid', 'approved_at'], ['approved', 'approval_grandfathered_at'],
  ] as const)('%s with %s: app_user and platform_admin are refused, named, and the row stays', async (status, stamp) => {
    const h = await header(A, status, stamp, 6);
    await as(owner, async (c) => {
      await expect(c.query('DELETE FROM payroll_run_headers WHERE id = $1', [h])).rejects
        .toMatchObject({ code: '23514', message: expect.stringMatching(FINAL_REFUSED) });
    });
    await as(admin, async (c) => {
      await expect(c.query('DELETE FROM payroll_run_headers WHERE id = $1', [h])).rejects.toThrow(FINAL_REFUSED);
    });
    expect(await one('SELECT status FROM payroll_run_headers WHERE id = $1', [h])).toEqual({ status });
    await su.query('DELETE FROM payroll_run_headers WHERE id = $1', [h]); // the superuser is exempt (999n's rule)
    expect(await exists(h)).toBe(false);
  });
  it('approve, then a status flip out of approved (no history written), then DELETE: refused by the evidence', async () => {
    const h = await header(A, 'approved', 'approved_at', 1);
    await as(owner, async (c) => {
      // 999n lets a final run leave approved with its stamps cleared; nothing here appends approval_history.
      expect(await n(c, "UPDATE payroll_run_headers SET status = 'calculated', approved_at = NULL WHERE id = $1", [h])).toBe(1);
      await expect(c.query('DELETE FROM payroll_run_headers WHERE id = $1', [h])).rejects
        .toMatchObject({ code: '23514', message: expect.stringMatching(EVIDENCE_REFUSED) });
    });
    expect(await exists(h)).toBe(true);
  });
  it('approve, then cancel (stamps cleared), then DELETE: refused, and ever_final_at cannot be cleared or forged', async () => {
    const h = await header(A, 'approved', 'approved_at', 2);
    await as(owner, async (c) => {
      expect(await n(c, "UPDATE payroll_run_headers SET status = 'cancelled', approved_at = NULL WHERE id = $1", [h])).toBe(1);
      expect(await n(c, 'UPDATE payroll_run_headers SET ever_final_at = NULL WHERE id = $1', [h])).toBe(1);
      expect((await c.query('SELECT ever_final_at IS NOT NULL AS set FROM payroll_run_headers WHERE id = $1', [h])).rows[0].set).toBe(true);
      const forged = (await c.query(`INSERT INTO payroll_run_headers (company_id, period_month, period_year, status, ever_final_at)
        VALUES ($1, 9, $2, 'draft', now()) RETURNING ever_final_at`, [A, YEAR])).rows[0];
      expect(forged.ever_final_at).toBeNull();
      await expect(c.query('DELETE FROM payroll_run_headers WHERE id = $1', [h])).rejects.toThrow(EVIDENCE_REFUSED);
    });
  });
  it('approve, then the app\'s reopen (history and reopened_at written), then DELETE: refused', async () => {
    const h = await header(A, 'approved', 'approved_at', 12);
    await as(owner, async (c) => {
      expect(await n(c, `UPDATE payroll_run_headers SET status = 'calculated', approved_at = NULL, reopened_at = clock_timestamp(),
        approval_history = tstzmultirange(tstzrange(approved_at, clock_timestamp())) WHERE id = $1`, [h])).toBe(1);
      await expect(c.query('DELETE FROM payroll_run_headers WHERE id = $1', [h])).rejects.toThrow(EVIDENCE_REFUSED);
    });
    expect(await exists(h)).toBe(true);
  });
  it.each([
    ['reopened_at set', "reopened_at = now()"], ['a cancelled run that kept its approved_at', "status = 'cancelled', approved_at = now()"],
    ['a stamp-only grandfathered run', "approval_grandfathered_at = now()"],
  ])('a row that left final before 1054 (no ever_final_at), %s: refused', async (_what, set) => {
    const h = await header(A, 'calculated', null, 5);
    try {
      await su.query(`UPDATE payroll_run_headers SET ${set} WHERE id = $1`, [h]);
      expect((await one('SELECT ever_final_at FROM payroll_run_headers WHERE id = $1', [h])).ever_final_at).toBeNull();
      await as(owner, async (c) => {
        await expect(c.query('DELETE FROM payroll_run_headers WHERE id = $1', [h])).rejects.toThrow(EVIDENCE_REFUSED);
      });
    } finally {
      await su.query('DELETE FROM payroll_run_headers WHERE id = $1', [h]);
    }
  });
  it('a draft, and an approved run with no approval stamp (never final), still delete', async () => {
    const d = await header(A, 'draft', null, 7);
    const unstamped = await header(A, 'approved', null, 8);
    await as(owner, async (c) => {
      expect(await n(c, 'DELETE FROM payroll_run_headers WHERE id = ANY($1)', [[d, unstamped]])).toBe(2);
    });
  });
});

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
