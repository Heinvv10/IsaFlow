/**
 * Wave 7 RH (migration 1054), the breaker's repros of fb88f3fd9d, each run as the attacking role:
 *  B1 platform_admin / migration_admin fire a DELETE of a final (or once-approved) header from a pg_temp trigger, so the
 *     guard runs nested: refused (the cascade exemption needs the company row gone), while a real company delete
 *     still cascades (w7-rh-teardown);
 *  B2 TRUNCATE payroll_run_headers: refused by the statement trigger for a non-superuser that holds TRUNCATE, and
 *     migration_admin no longer holds it;
 *  B3 app_user renames an approved header's id (with and without lines) to free the old id: refused; an employee's id
 *     is fixed too;
 *  B4 app_user clears reopened_at on a reopened run: the delete is still refused (approval_evidence_at stays);
 *  R2-H platform_admin / migration_admin swap the victim company's id away for one statement so the nested DELETE sees
 *     its company "gone", then swap it back: refused (companies.id is fixed);
 *  R2-L app_user cannot call payroll_company_row_exists.
 * Every case runs in a transaction that is rolled back; seeding as the fixture's superuser.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';

const su = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const [A, UA, EA] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
const YEAR = 2100 + Math.floor(Math.random() * 800);
const FINAL_REFUSED = /a final pay run is not deleted/;
const EVIDENCE_REFUSED = /a pay run that was approved before is not deleted; cancel it instead/;
const FIXED = /payroll_run_headers: a row's id and company are fixed/;
let FIN = '';
let REOPENED = '';

const one = async (q: string, p: unknown[] = []) => (await su.query(q, p)).rows[0];
async function header(month: number): Promise<string> {
  return (await one(`INSERT INTO payroll_run_headers (company_id, period_month, period_year, status, run_date, total_gross,
    total_paye, total_net, employee_count) VALUES ($1, $2, $3, 'calculated', make_date($3, $2, 28), 10000, 2000, 8000, 1)
    RETURNING id`, [A, month, YEAR])).id as string;
}

beforeAll(async () => {
  await su.query("INSERT INTO companies (id, name) VALUES ($1, 'RH breaker A')", [A]);
  await su.query('INSERT INTO users (id, email) VALUES ($1, $2)', [UA, `${UA}@example.invalid`]);
  await su.query("INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'admin')", [A, UA]);
  await su.query(`INSERT INTO payroll_employees (id, company_id, employee_number, first_name, last_name, start_date)
    VALUES ($1, $2, 'RHB-A', 'Ann', 'A', '2025-01-01')`, [EA, A]);
  FIN = await header(1);
  await su.query('INSERT INTO payroll_run_lines (run_id, employee_id, gross_pay, net_pay) VALUES ($1, $2, 10000, 8000)', [FIN, EA]);
  await su.query("UPDATE payroll_run_headers SET status = 'approved', approved_at = now() WHERE id = $1", [FIN]);
  REOPENED = await header(2);
  await su.query("UPDATE payroll_run_headers SET status = 'approved', approved_at = now() - interval '1 day' WHERE id = $1", [REOPENED]);
  await su.query(`UPDATE payroll_run_headers SET status = 'calculated', approved_at = NULL, reopened_at = now(),
    approval_history = tstzmultirange(tstzrange(approved_at, now())) WHERE id = $1`, [REOPENED]);
}, 60_000);

afterAll(async () => {
  try {
    await su.query('DELETE FROM payroll_run_headers WHERE company_id = $1', [A]);
    await su.query('DELETE FROM payroll_employees WHERE company_id = $1', [A]);
    await su.query('DELETE FROM company_users WHERE company_id = $1', [A]);
    await su.query('DELETE FROM companies WHERE id = $1', [A]);
    await su.query('DELETE FROM users WHERE id = $1', [UA]);
  } finally { await su.end(); }
});

/** `fn` in one transaction as `role` (app_user gets withAuth's claims for A), always rolled back. */
async function as<T>(role: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await su.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SET LOCAL ROLE ${role}`);
    if (role === 'app_user') {
      await c.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: UA, role: 'authenticated' })]);
      await c.query("SELECT set_config('app.current_company_id', $1, true)", [A]);
    }
    return await fn(c);
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
}
const exists = async (id: string) => (await one('SELECT count(*)::int AS n FROM payroll_run_headers WHERE id = $1', [id])).n === 1;

describe('B1: a DELETE fired from a pg_temp trigger is not the company cascade', () => {
  it.each(['platform_admin', 'migration_admin'])('%s: the nested delete of a final and of a once-approved header is refused', async (role) => {
    for (const [id, refusal] of [[FIN, FINAL_REFUSED], [REOPENED, EVIDENCE_REFUSED]] as const) {
      await as(role, async (c) => {
        expect((await c.query("SELECT current_setting('is_superuser') AS s")).rows[0].s).toBe('off');
        await c.query('CREATE TEMP TABLE kick (id uuid) ON COMMIT DROP');
        await c.query(`CREATE FUNCTION pg_temp.zap() RETURNS trigger LANGUAGE plpgsql AS $f$
          BEGIN DELETE FROM public.payroll_run_headers WHERE id = NEW.id; RETURN NEW; END $f$`);
        await c.query('CREATE TRIGGER kick_t AFTER INSERT ON pg_temp.kick FOR EACH ROW EXECUTE FUNCTION pg_temp.zap()');
        await expect(c.query('INSERT INTO pg_temp.kick VALUES ($1)', [id])).rejects.toThrow(refusal);
      });
      expect(await exists(id)).toBe(true);
    }
  });
});

describe('B2: TRUNCATE', () => {
  it('a non-superuser holding TRUNCATE is refused by the statement trigger, and migration_admin holds none', async () => {
    const role = `zz_rh_trunc_${crypto.randomUUID().slice(0, 8)}`;
    const c = await su.connect();
    try {
      await c.query('BEGIN');
      await c.query(`CREATE ROLE ${role} NOLOGIN`);
      // Every table the CASCADE reaches, so the refusal is the trigger's and not a missing privilege.
      await c.query(`GRANT TRUNCATE ON ALL TABLES IN SCHEMA public TO ${role}`);
      await c.query(`SET LOCAL ROLE ${role}`);
      await expect(c.query('TRUNCATE payroll_run_headers CASCADE')).rejects
        .toMatchObject({ code: '23514', message: expect.stringMatching(/pay runs are not truncated/) });
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
    expect((await one("SELECT has_table_privilege('migration_admin', 'public.payroll_run_headers', 'TRUNCATE') AS t")).t).toBe(false);
    await as('migration_admin', async (x) => {
      await expect(x.query('TRUNCATE payroll_run_headers CASCADE')).rejects.toMatchObject({ code: '42501' });
    });
    expect(await exists(FIN)).toBe(true);
  });
});

describe('B3: an id is fixed', () => {
  it('app_user cannot rename a final header (with lines) or a once-approved one (no lines) to free its id', async () => {
    const other = crypto.randomUUID();
    for (const id of [FIN, REOPENED]) {
      await as('app_user', async (c) => {
        await expect(c.query('UPDATE payroll_run_headers SET id = $2 WHERE id = $1', [id, other])).rejects
          .toMatchObject({ code: '23514', message: expect.stringMatching(FIXED) });
      });
      expect(await exists(id)).toBe(true);
    }
  });
  it('an employee\'s id is fixed too', async () => {
    await as('app_user', async (c) => {
      await expect(c.query('UPDATE payroll_employees SET id = $2 WHERE id = $1', [EA, crypto.randomUUID()])).rejects
        .toThrow(/payroll_employees: a row's id and company are fixed/);
    });
  });
});

describe('B4: clearing reopened_at does not free a once-approved run', () => {
  it('app_user clears reopened_at, and the delete is still refused', async () => {
    await as('app_user', async (c) => {
      expect((await c.query('UPDATE payroll_run_headers SET reopened_at = NULL, approval_evidence_at = NULL WHERE id = $1 RETURNING approval_evidence_at',
        [REOPENED])).rows[0].approval_evidence_at).not.toBeNull();
      await expect(c.query('DELETE FROM payroll_run_headers WHERE id = $1', [REOPENED])).rejects.toThrow(EVIDENCE_REFUSED);
    });
  });
});

describe('round 2 H: a company\'s id is fixed, so "the company row is gone" cannot be faked', () => {
  it.each(['platform_admin', 'migration_admin'])('%s: the id-swap route to the nested delete is refused', async (role) => {
    await as(role, async (c) => {
      await c.query('CREATE TEMP TABLE kick (v uuid) ON COMMIT DROP');
      await c.query(`CREATE FUNCTION pg_temp.zap() RETURNS trigger LANGUAGE plpgsql AS $f$
        BEGIN
          DELETE FROM public.payroll_run_headers WHERE id = '${FIN}';
          UPDATE public.companies SET id = NEW.v WHERE id = 'ffffffff-0000-4000-8000-0000000000ff';
          RETURN NEW;
        END $f$`);
      await c.query('CREATE TRIGGER kick_t AFTER INSERT ON pg_temp.kick FOR EACH ROW EXECUTE FUNCTION pg_temp.zap()');
      await expect(c.query(`WITH k AS (INSERT INTO pg_temp.kick VALUES ($1) RETURNING v)
        UPDATE public.companies SET id = 'ffffffff-0000-4000-8000-0000000000ff' WHERE id = (SELECT v FROM k)`, [A])).rejects
        .toMatchObject({ code: '23514', message: expect.stringMatching(/companies: a company's id is fixed/) });
    });
    expect(await exists(FIN)).toBe(true);
    expect((await one('SELECT count(*)::int AS n FROM companies WHERE id = $1', [A])).n).toBe(1);
  });
  it('a direct re-key of a company is refused too, and other company columns still update', async () => {
    await as('platform_admin', async (c) => {
      await c.query('SAVEPOINT k');
      await expect(c.query('UPDATE companies SET id = gen_random_uuid() WHERE id = $1', [A])).rejects.toThrow(/a company's id is fixed/);
      await c.query('ROLLBACK TO SAVEPOINT k');
      expect((await c.query("UPDATE companies SET name = 'RH breaker A2' WHERE id = $1", [A])).rowCount).toBe(1);
    });
  });
});

describe('round 2 L: payroll_company_row_exists is not app_user\'s', () => {
  it('app_user cannot execute it; platform_admin can', async () => {
    await as('app_user', async (c) => {
      await expect(c.query('SELECT public.payroll_company_row_exists($1)', [A])).rejects.toMatchObject({ code: '42501' });
    });
    await as('platform_admin', async (c) => {
      expect((await c.query('SELECT public.payroll_company_row_exists($1) AS e', [A])).rows[0].e).toBe(true);
    });
  });
});
