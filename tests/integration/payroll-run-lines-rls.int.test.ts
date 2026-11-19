/**
 * Wave 6 RLS-L (migration 1011): payroll_run_lines under ENABLE + FORCE row level security, tenant through the parent
 * payroll_run_headers row (tenant_isolation_via_parent_select/_insert/_update/_delete). Two tenants on the disposable fixture, every statement run
 * as app_user with withAuth's claims (sub + app.current_company_id) inside a transaction that is rolled back:
 *  - tenant A cannot SELECT, UPDATE or DELETE B's lines, by line id or by B's run id;
 *  - A cannot INSERT a line onto B's run, nor move its own line onto it;
 *  - a user of both tenants reads both (the header's USING), but inserts, updates and deletes only the ACTIVE
 *    company's lines (breaker #1673 L1);
 *  - a line's employee must be an employee of its run's company (breaker #1673 L2: the FK ignores RLS);
 *  - a session with no claims sees nothing; the service role (app_service) keeps its mirror and sees both;
 *  - deleting a header as app_user still cascades to its lines;
 *  - a year-wide aggregate stays costed like the unprotected query (no JIT-triggering policy shape).
 * Seeding runs as the fixture's superuser.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';

const su = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const A = crypto.randomUUID();
const B = crypto.randomUUID();
const UA = crypto.randomUUID();
const UB = crypto.randomUUID();
const UAB = crypto.randomUUID();
const EA = crypto.randomUUID();
const EB = crypto.randomUUID();
const EA2 = crypto.randomUUID();
const EB2 = crypto.randomUUID();
const YEAR = 2100 + Math.floor(Math.random() * 800);
let HA = '';
let HB = '';
let LA = '';
let LB = '';

const one = async (q: string, p: unknown[] = []) => (await su.query(q, p)).rows[0];

beforeAll(async () => {
  await su.query("INSERT INTO companies (id, name) VALUES ($1, 'RLS-L A'), ($2, 'RLS-L B')", [A, B]);
  await su.query(`INSERT INTO users (id, email) VALUES ($1, $4), ($2, $5), ($3, $6)`,
    [UA, UB, UAB, `${UA}@example.invalid`, `${UB}@example.invalid`, `${UAB}@example.invalid`]);
  await su.query(`INSERT INTO company_users (company_id, user_id, role) VALUES
    ($1, $3, 'admin'), ($2, $4, 'admin'), ($1, $5, 'admin'), ($2, $5, 'admin')`, [A, B, UA, UB, UAB]);
  await su.query(`INSERT INTO payroll_employees (id, company_id, employee_number, first_name, last_name, start_date) VALUES
    ($1, $3, 'RL-A', 'Ann', 'A', '2025-01-01'), ($2, $4, 'RL-B', 'Ben', 'B', '2025-01-01'),
    ($5, $3, 'RL-A2', 'Amy', 'A', '2025-01-01'), ($6, $4, 'RL-B2', 'Bea', 'B', '2025-01-01')`, [EA, EB, A, B, EA2, EB2]);
  const run = async (company: string) => (await one(`INSERT INTO payroll_run_headers
      (company_id, period_month, period_year, status, run_date, total_gross, total_paye, total_net, employee_count)
    VALUES ($1, 3, $2, 'calculated', make_date($2, 3, 28), 1000, 200, 800, 1) RETURNING id`, [company, YEAR])).id as string;
  HA = await run(A);
  HB = await run(B);
  const line = async (h: string, e: string) => (await one(
    'INSERT INTO payroll_run_lines (run_id, employee_id, gross_pay, paye, net_pay) VALUES ($1, $2, 1000, 200, 800) RETURNING id',
    [h, e])).id as string;
  LA = await line(HA, EA);
  LB = await line(HB, EB);
}, 60_000);

afterAll(async () => {
  try {
    await su.query('DELETE FROM payroll_run_headers WHERE company_id = ANY($1)', [[A, B]]);
    await su.query('DELETE FROM payroll_employees WHERE company_id = ANY($1)', [[A, B]]);
    await su.query('DELETE FROM company_users WHERE company_id = ANY($1)', [[A, B]]);
    await su.query('DELETE FROM companies WHERE id = ANY($1)', [[A, B]]);
    await su.query('DELETE FROM users WHERE id = ANY($1)', [[UA, UB, UAB]]);
  } finally { await su.end(); }
});

type Session = { user: string | null; company: string | null; role?: 'app_user' | 'app_service' };
/** `fn` in one transaction as `who` (withAuth's role and claims), always rolled back. */
async function as<T>(who: Session, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await su.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SET LOCAL ROLE ${who.role ?? 'app_user'}`);
    if (who.user) {
      await c.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: who.user, role: 'authenticated' })]);
    }
    if (who.company) await c.query("SELECT set_config('app.current_company_id', $1, true)", [who.company]);
    return await fn(c);
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
}
const asA = <T>(fn: (c: PoolClient) => Promise<T>) => as({ user: UA, company: A }, fn);
const ids = async (c: PoolClient, where: string, p: unknown[]) =>
  (await c.query(`SELECT id FROM payroll_run_lines WHERE ${where} ORDER BY id`, p)).rows.map((r) => r.id as string);
/** Refused by the policy's WITH CHECK (42501). */
const refused = (p: Promise<unknown>) => expect(p).rejects.toMatchObject({ code: '42501' });
/**
 * Refused, by the policy (42501) or first by 999n's freeze trigger (23514): its DEFINER finality lookup answers
 * "final" for a header the caller cannot see, so a write onto another tenant's run fails in the BEFORE trigger. The
 * policy alone is proved by the both-tenants user below, whose header the trigger does see.
 */
const refusedEither = (p: Promise<unknown>) => expect(p).rejects.toSatisfy(
  (e: { code?: string }) => e.code === '42501' || e.code === '23514');

describe('RLS-L: payroll_run_lines is under ENABLE + FORCE with one app_user policy', () => {
  it('the catalogue says so', async () => {
    expect(await one(`SELECT relrowsecurity AS on, relforcerowsecurity AS force FROM pg_class
      WHERE oid = 'public.payroll_run_lines'::regclass`)).toEqual({ on: true, force: true });
    const pols = (await su.query(`SELECT policyname, roles::text[] AS roles, cmd FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'payroll_run_lines' ORDER BY policyname`)).rows;
    expect(pols.filter((p) => p.roles.includes('app_user') || p.roles.includes('public')))
      .toEqual([
        { policyname: 'tenant_isolation_via_parent_delete', roles: ['app_user'], cmd: 'DELETE' },
        { policyname: 'tenant_isolation_via_parent_insert', roles: ['app_user'], cmd: 'INSERT' },
        { policyname: 'tenant_isolation_via_parent_select', roles: ['app_user'], cmd: 'SELECT' },
        { policyname: 'tenant_isolation_via_parent_update', roles: ['app_user'], cmd: 'UPDATE' },
      ]);
    expect(pols.filter((p) => p.roles.includes('app_service')).map((p) => p.policyname))
      .toEqual(['app_service_delete', 'app_service_insert', 'app_service_select', 'app_service_update']);
  });
});

describe('RLS-L: tenant A cannot reach tenant B\'s lines', () => {
  it('reads: A sees its own line and not B\'s, by line id or by B\'s run id', async () => {
    await asA(async (c) => {
      expect(await ids(c, 'id = ANY($1)', [[LA, LB]])).toEqual([LA]);
      expect(await ids(c, 'run_id = $1', [HB])).toEqual([]);
      expect((await c.query('SELECT count(*)::int AS n FROM payroll_run_lines WHERE employee_id = $1', [EB])).rows[0].n).toBe(0);
    });
    await as({ user: UB, company: B }, async (c) => expect(await ids(c, 'id = ANY($1)', [[LA, LB]])).toEqual([LB]));
  });

  it('UPDATE and DELETE of B\'s line touch nothing', async () => {
    await asA(async (c) => {
      expect((await c.query('UPDATE payroll_run_lines SET net_pay = 1 WHERE id = $1', [LB])).rowCount).toBe(0);
      expect((await c.query('UPDATE payroll_run_lines SET payslip_snapshot = $2 WHERE run_id = $1', [HB, '{}'])).rowCount).toBe(0);
      expect((await c.query('DELETE FROM payroll_run_lines WHERE run_id = $1', [HB])).rowCount).toBe(0);
      expect((await c.query('DELETE FROM payroll_run_lines WHERE id = $1', [LB])).rowCount).toBe(0);
    });
    expect(await one('SELECT net_pay::text AS net, payslip_snapshot AS snap FROM payroll_run_lines WHERE id = $1', [LB]))
      .toEqual({ net: '800.00', snap: null });
  });

  it('INSERT of a line onto B\'s run is refused', async () => {
    await refusedEither(asA((c) => c.query(
      'INSERT INTO payroll_run_lines (run_id, employee_id, net_pay) VALUES ($1, $2, 1)', [HB, EA2])));
    await refusedEither(asA((c) => c.query(
      'INSERT INTO payroll_run_lines (run_id, employee_id, net_pay) VALUES ($1, $2, 1)', [HB, EB])));
  });

  it('moving A\'s own line onto B\'s run is refused', async () => {
    await refusedEither(asA((c) => c.query('UPDATE payroll_run_lines SET run_id = $2 WHERE id = $1', [LA, HB])));
    await refused(as({ user: UAB, company: A }, (c) => c.query('UPDATE payroll_run_lines SET run_id = $2 WHERE id = $1', [LA, HB])));
  });

  it('a user of both tenants reads both, but inserts, updates and deletes only the active company\'s lines', async () => {
    await as({ user: UAB, company: A }, async (c) => {
      expect(await ids(c, 'id = ANY($1)', [[LA, LB]])).toEqual([LA, LB].sort());
      expect((await c.query('INSERT INTO payroll_run_lines (run_id, employee_id, net_pay) VALUES ($1, $2, 1)', [HA, EA2])).rowCount).toBe(1);
      expect((await c.query('UPDATE payroll_run_lines SET net_pay = 1 WHERE id = $1', [LB])).rowCount).toBe(0);
      expect((await c.query('DELETE FROM payroll_run_lines WHERE id = $1', [LB])).rowCount).toBe(0);
      expect((await c.query('DELETE FROM payroll_run_lines WHERE run_id = $1', [HB])).rowCount).toBe(0);
    });
    // B's own employee onto B's run: only the active-company rule refuses it.
    await refused(as({ user: UAB, company: A }, (c) => c.query(
      'INSERT INTO payroll_run_lines (run_id, employee_id, net_pay) VALUES ($1, $2, 1)', [HB, EB2])));
    expect(await one('SELECT net_pay::text AS net FROM payroll_run_lines WHERE id = $1', [LB])).toEqual({ net: '800.00' });
  });

  it('a line\'s employee is an employee of its run\'s company: A cannot put B\'s employee on A\'s run', async () => {
    await refused(asA((c) => c.query(
      'INSERT INTO payroll_run_lines (run_id, employee_id, net_pay) VALUES ($1, $2, 1)', [HA, EB2])));
    await refused(asA((c) => c.query('UPDATE payroll_run_lines SET employee_id = $2 WHERE id = $1', [LA, EB2])));
    // A user of both, with A active, cannot either: the employee rule is about the run's company, not the user's reach.
    await refused(as({ user: UAB, company: A }, (c) => c.query(
      'INSERT INTO payroll_run_lines (run_id, employee_id, net_pay) VALUES ($1, $2, 1)', [HA, EB2])));
  });

  it('A still writes its own run: insert, update, delete', async () => {
    await asA(async (c) => {
      expect((await c.query('INSERT INTO payroll_run_lines (run_id, employee_id, net_pay) VALUES ($1, $2, 1)', [HA, EA2])).rowCount).toBe(1);
      expect((await c.query('UPDATE payroll_run_lines SET net_pay = 2 WHERE id = $1', [LA])).rowCount).toBe(1);
      expect((await c.query('DELETE FROM payroll_run_lines WHERE run_id = $1', [HA])).rowCount).toBe(2);
    });
  });

  it('a session with no claims sees no line; one whose claims name another company\'s user sees none of A\'s', async () => {
    await as({ user: null, company: null }, async (c) => expect(await ids(c, 'id = ANY($1)', [[LA, LB]])).toEqual([]));
    await as({ user: UB, company: A }, async (c) => expect(await ids(c, 'run_id = $1', [HA])).toEqual([]));
    await refusedEither(as({ user: null, company: A }, (c) => c.query(
      'INSERT INTO payroll_run_lines (run_id, employee_id, net_pay) VALUES ($1, $2, 1)', [HA, EA2])));
  });

  it('the service role keeps every line through its mirror policies', async () => {
    await as({ user: null, company: null, role: 'app_service' }, async (c) =>
      expect(await ids(c, 'id = ANY($1)', [[LA, LB]])).toEqual([LA, LB].sort()));
  });

  it('deleting a header as app_user still cascades to its lines', async () => {
    await asA(async (c) => {
      expect((await c.query('DELETE FROM payroll_run_headers WHERE id = $1', [HA])).rowCount).toBe(1);
      await c.query('RESET ROLE');
      expect((await c.query('SELECT count(*)::int AS n FROM payroll_run_lines WHERE run_id = $1', [HA])).rows[0].n).toBe(0);
    });
  });
});

describe('RLS-L: the read policy keeps a year-wide aggregate costed like the unprotected query (#1673 L3)', () => {
  // A company of 60 runs x 40 employees (2,400 lines), ANALYZEd so the planner costs it as it is. The round-1 shape (a
  // correlated EXISTS per line) estimated ~335x the unprotected query on 48k lines, passed jit_above_cost and JIT made
  // the IRP5/EMP501 aggregate ~20x slower. Here the round-1 shape costs ~620x; the shipped `run_id IN (SELECT ...)`
  // ~1.5x at this size (its fixed set-building cost) and ~1.05x at 48k lines. The bound is 3x.
  const P = crypto.randomUUID();
  const UP = crypto.randomUUID();
  beforeAll(async () => {
    await su.query("INSERT INTO companies (id, name) VALUES ($1, 'RLS-L plan')", [P]);
    await su.query('INSERT INTO users (id, email) VALUES ($1, $2)', [UP, `${UP}@example.invalid`]);
    await su.query("INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'admin')", [P, UP]);
    await su.query(`INSERT INTO payroll_employees (company_id, employee_number, first_name, last_name, start_date)
      SELECT $1, 'PL-' || g, 'P', 'L', '2025-01-01' FROM generate_series(1, 40) g`, [P]);
    await su.query(`INSERT INTO payroll_run_headers (company_id, period_month, period_year, status, run_date)
      SELECT $1, 1 + (g % 12), $2 + g / 12, 'calculated', make_date($2 + g / 12, 1 + (g % 12), 1) FROM generate_series(0, 59) g`,
    [P, YEAR]);
    await su.query(`INSERT INTO payroll_run_lines (run_id, employee_id, gross_pay, paye, net_pay)
      SELECT h.id, e.id, 100, 10, 90 FROM payroll_run_headers h JOIN payroll_employees e ON e.company_id = h.company_id
       WHERE h.company_id = $1`, [P]);
    await su.query('ANALYZE payroll_run_lines');
    await su.query('ANALYZE payroll_run_headers');
  }, 60_000);
  afterAll(async () => {
    await su.query('DELETE FROM payroll_run_headers WHERE company_id = $1', [P]);
    await su.query('DELETE FROM payroll_employees WHERE company_id = $1', [P]);
    await su.query('DELETE FROM company_users WHERE company_id = $1', [P]);
    await su.query('DELETE FROM companies WHERE id = $1', [P]);
    await su.query('DELETE FROM users WHERE id = $1', [UP]);
  });

  const AGG = `EXPLAIN (FORMAT JSON) SELECT count(*), sum(l.paye) FROM payroll_run_lines l
    JOIN payroll_run_headers h ON h.id = l.run_id WHERE h.company_id = $1`;
  const cost = (r: { rows: Array<Record<string, unknown>> }) =>
    Number((r.rows[0]!['QUERY PLAN'] as Array<{ Plan: { 'Total Cost': number } }>)[0]!.Plan['Total Cost']);

  it('estimated cost as app_user is under 3x the same query without row security on the lines, and under JIT', async () => {
    const withPolicy = await as({ user: UP, company: P }, async (c) => cost(await c.query(AGG, [P])));
    const jitAbove = await as({ user: UP, company: P }, async (c) =>
      Number((await c.query("SELECT current_setting('jit_above_cost') AS v")).rows[0].v));
    const c = await su.connect();
    let without = 0;
    try {
      await c.query('BEGIN');
      await c.query('ALTER TABLE payroll_run_lines DISABLE ROW LEVEL SECURITY');
      await c.query('SET LOCAL ROLE app_user');
      await c.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: UP, role: 'authenticated' })]);
      await c.query("SELECT set_config('app.current_company_id', $1, true)", [P]);
      without = cost(await c.query(AGG, [P]));
    } finally { await c.query('ROLLBACK'); c.release(); }
    expect(without).toBeGreaterThan(0);
    expect(withPolicy / without, `with ${withPolicy} vs without ${without}`).toBeLessThan(3);
    expect(withPolicy).toBeLessThan(jitAbove);
  });
});
