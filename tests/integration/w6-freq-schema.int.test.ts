/**
 * Wave 6 FQa (migration 999a): pay frequency and run kind, the period trigger, the regular-period unique index,
 * the run population filtered by frequency (grill F3), and the forward-compat guard (payrollRunKindGuard) refusing
 * what this release cannot cost, before any write. Real chain (withAuth, app_user, RLS, Postgres) for the routes;
 * the clauses for columns and tables later PRs add are made inside a rolled-back transaction, so no other suite
 * on this database ever sees them. Disposable fixture DB only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { SignJWT } from 'jose';
import { als } from '@/lib/als';
import { assertRunKindSupported, RunKindUnsupportedError, type RunKindAction } from '@/modules/accounting/services/payroll/payrollRunKindGuard';
import approve from '../../pages/api/payroll/runs/[id]/approve';
import calculate from '../../pages/api/payroll/runs/[id]/calculate';
import reopen from '../../pages/api/payroll/runs/[id]/reopen';
import runDetail from '../../pages/api/payroll/runs/[id]';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { calculatedRun, cleanPayrollCompanies, routeCaller, seedPayrollCompany, type Route } from './w3-01-payroll.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const A = crypto.randomUUID();
const B = crypto.randomUUID();
const adminA = crypto.randomUUID();
const adminB = crypto.randomUUID();
const tokens: Record<string, string> = {};
const call = routeCaller(tokens, { user: adminA, company: A });
let monthlyEmp = '';
let weeklyEmp = '';
let runId = '';

const one = async (text: string, params: unknown[] = []) => (await pool.query(text, params)).rows[0] as Record<string, unknown>;

/** Everything a refused request could have touched: the header row, its lines, its loan payments. */
async function snapshot(id: string): Promise<string> {
  return JSON.stringify([
    await one('SELECT row_to_json(h)::text AS h FROM payroll_run_headers h WHERE id = $1', [id]),
    (await pool.query('SELECT row_to_json(l)::text AS l FROM payroll_run_lines l WHERE run_id = $1 ORDER BY id', [id])).rows,
    await one('SELECT count(*)::int AS n FROM payroll_loan_payments WHERE run_id = $1', [id]),
  ]);
}

async function seedUser(user: string, company: string): Promise<void> {
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@example.invalid`]);
  tokens[user] = await new SignJWT({ sub: user, aal: 'aal2', session_id: crypto.randomUUID() }).setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')", [company, user]);
}

/** Run `fn` on one client in a transaction that is always rolled back: `prepare` may change the schema. */
async function inRolledBackTx(prepare: (c: PoolClient) => Promise<void>, fn: () => Promise<void>): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await prepare(client);
    await als.run({ client, userId: adminA, companyId: A, claims: { sub: adminA } } as never, fn);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

async function refusal(action: RunKindAction, company = A): Promise<RunKindUnsupportedError | null> {
  try {
    await assertRunKindSupported(company, runId, action);
    return null;
  } catch (err) {
    if (err instanceof RunKindUnsupportedError) return err;
    throw err;
  }
}
const clauses = (e: RunKindUnsupportedError | null) => (e ? e.reasons.map((r) => r.clause) : []);

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2),($3,$4)', [A, 'W6 FQa A', B, 'W6 FQa B']);
  const salary = await seedPayrollCompany(pool, A);
  monthlyEmp = String((await one('SELECT employee_id FROM payroll_employee_components WHERE id = $1', [salary])).employee_id);
  await seedPayrollCompany(pool, B);
  weeklyEmp = String((await one(
    `INSERT INTO payroll_employees (company_id, employee_number, first_name, last_name, start_date, date_of_birth, tax_number, pay_frequency)
     VALUES ($1, 'W6-WEEK', 'Wendy', 'Weekly', '2020-01-01', '1985-01-01', '0123456780', 'weekly') RETURNING id`, [A])).id);
  await pool.query(
    `INSERT INTO payroll_employee_components (employee_id, component_id, amount, effective_from)
     SELECT $1, component_id, 9000, '2020-01-01' FROM payroll_employee_components WHERE id = $2`, [weeklyEmp, salary]);
  await seedUser(adminA, A);
  await seedUser(adminB, B);
  runId = await calculatedRun(call, 4);
});

afterAll(async () => {
  try {
    await cleanPayrollCompanies(pool, [A, B]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [[adminA, adminB]]);
  } finally { await pool.end(); }
});

describe('999a schema', () => {
  it('an old-style insert (no new columns) is filled by the trigger, and a month change refills it', async () => {
    const row = await one(
      `INSERT INTO payroll_run_headers (company_id, period_month, period_year) VALUES ($1, 2, 2028)
       RETURNING id, pay_frequency, run_kind, off_cycle_reason, period_start::text AS s, period_end::text AS e`, [A]);
    expect(row).toMatchObject({ pay_frequency: 'monthly', run_kind: 'regular', off_cycle_reason: null, s: '2028-02-01', e: '2028-02-29' });
    const moved = await one('UPDATE payroll_run_headers SET period_month = 3 WHERE id = $1 RETURNING period_start::text AS s, period_end::text AS e', [row.id]);
    expect(moved).toEqual({ s: '2028-03-01', e: '2028-03-31' });
    await pool.query('DELETE FROM payroll_run_headers WHERE id = $1', [row.id]);
  });

  it("the backfill's month bounds: leap and common February, December", async () => {
    const r = await one(`SELECT payroll_month_period_end(2028, 2)::text AS leap, payroll_month_period_end(2027, 2)::text AS feb,
      payroll_month_period_start(2026, 12)::text AS ds, payroll_month_period_end(2026, 12)::text AS de`);
    expect(r).toEqual({ leap: '2028-02-29', feb: '2027-02-28', ds: '2026-12-01', de: '2026-12-31' });
  });

  it('two monthly regular runs for one period are refused (23505), by the new period key too', async () => {
    await expect(pool.query('INSERT INTO payroll_run_headers (company_id, period_month, period_year) VALUES ($1, 4, 2026)', [A]))
      .rejects.toMatchObject({ code: '23505' });
    // Month 5 claiming April's period start: only the new (company, frequency, period_start) key can refuse it.
    await expect(pool.query(
      "INSERT INTO payroll_run_headers (company_id, period_month, period_year, period_start, period_end) VALUES ($1, 5, 2026, '2026-04-01', '2026-04-30')", [A]))
      .rejects.toMatchObject({ code: '23505', constraint: 'payroll_run_headers_regular_period_key' });
  });

  it('a non-monthly run keeps its own dates, needs them (23514), and off_cycle needs a reason', async () => {
    const w = await one(
      `INSERT INTO payroll_run_headers (company_id, period_month, period_year, pay_frequency, period_start, period_end)
       VALUES ($1, 6, 2028, 'weekly', '2028-06-05', '2028-06-11') RETURNING id, period_start::text AS s`, [A]);
    expect(w.s).toBe('2028-06-05');
    await pool.query('DELETE FROM payroll_run_headers WHERE id = $1', [w.id]);
    await expect(pool.query("INSERT INTO payroll_run_headers (company_id, period_month, period_year, pay_frequency) VALUES ($1, 7, 2028, 'weekly')", [A]))
      .rejects.toMatchObject({ code: '23514' });
    await expect(pool.query("INSERT INTO payroll_run_headers (company_id, period_month, period_year, run_kind) VALUES ($1, 8, 2028, 'off_cycle')", [A]))
      .rejects.toMatchObject({ code: '23514' });
  });
});

describe('run population and the guard (grill F3)', () => {
  it('a monthly run created through the route is monthly regular over its month, and pays no weekly employee', async () => {
    const h = await one('SELECT pay_frequency, run_kind, period_start::text AS s, period_end::text AS e FROM payroll_run_headers WHERE id = $1', [runId]);
    expect(h).toEqual({ pay_frequency: 'monthly', run_kind: 'regular', s: '2026-04-01', e: '2026-04-30' });
    const lines = (await pool.query('SELECT employee_id FROM payroll_run_lines WHERE run_id = $1', [runId])).rows.map((r) => r.employee_id);
    expect(lines).toEqual([monthlyEmp]);
    expect(lines).not.toContain(weeklyEmp);
  });

  it('approval of a run whose line employee is now weekly is refused, 409, with no row changed', async () => {
    const before = await snapshot(runId);
    await pool.query("UPDATE payroll_employees SET pay_frequency = 'weekly' WHERE id = $1", [monthlyEmp]);
    try {
      const r = await call(approve as Route, 'POST', `/api/payroll/runs/${runId}/approve`, runId, { body: { expectedPlanHash: 'x' } });
      expect(r.statusCode).toBe(409);
      expect(JSON.stringify(r.body)).toContain('RUN_KIND_UNSUPPORTED');
      expect(JSON.stringify(r.body)).toContain('W301-1');
    } finally {
      await pool.query("UPDATE payroll_employees SET pay_frequency = 'monthly' WHERE id = $1", [monthlyEmp]);
    }
    expect(await snapshot(runId)).toBe(before);
  });

  it('a weekly run is refused by calculate, approve and reopen, 409, with no row changed', async () => {
    const before = await snapshot(runId);
    await pool.query("UPDATE payroll_run_headers SET pay_frequency = 'weekly' WHERE id = $1", [runId]);
    const weekly = await snapshot(runId);
    try {
      for (const [route, action, body] of [[calculate, 'calculate', undefined], [approve, 'approve', { expectedPlanHash: 'x' }],
        [reopen, 'reopen', { reason: 'testing the guard' }]] as const) {
        const r = await call(route as Route, 'POST', `/api/payroll/runs/${runId}/${action}`, runId, { body });
        expect(r.statusCode, action).toBe(409);
        expect(JSON.stringify(r.body), action).toContain('weekly run');
        expect(await snapshot(runId), action).toBe(weekly);
      }
    } finally {
      await pool.query("UPDATE payroll_run_headers SET pay_frequency = 'monthly' WHERE id = $1", [runId]);
    }
    expect(await snapshot(runId)).toBe(before);
  });

  it('an off-cycle run is refused by calculate, 409, with no row changed', async () => {
    await pool.query("UPDATE payroll_run_headers SET run_kind = 'off_cycle', off_cycle_reason = 'bonus' WHERE id = $1", [runId]);
    try {
      const before = await snapshot(runId);
      const r = await call(calculate as Route, 'POST', `/api/payroll/runs/${runId}/calculate`, runId);
      expect(r.statusCode).toBe(409);
      expect(JSON.stringify(r.body)).toContain('off-cycle run');
      expect(await snapshot(runId)).toBe(before);
    } finally {
      await pool.query("UPDATE payroll_run_headers SET run_kind = 'regular', off_cycle_reason = NULL WHERE id = $1", [runId]);
    }
  });

  it('a locked (approved) run that is also off-cycle gets the lock refusal, as the dry run reports it (review #1483)', async () => {
    await pool.query("UPDATE payroll_run_headers SET status = 'approved', run_kind = 'off_cycle', off_cycle_reason = 'bonus' WHERE id = $1", [runId]);
    try {
      const before = await snapshot(runId);
      const r = await call(calculate as Route, 'POST', `/api/payroll/runs/${runId}/calculate`, runId);
      expect(r.statusCode).toBe(400);
      expect(JSON.stringify(r.body)).toContain('"lockedStatus":"approved"');
      expect(JSON.stringify(r.body)).not.toContain('RUN_KIND_UNSUPPORTED');
      expect(await snapshot(runId)).toBe(before);
    } finally {
      await pool.query("UPDATE payroll_run_headers SET status = 'calculated', run_kind = 'regular', off_cycle_reason = NULL WHERE id = $1", [runId]);
    }
  });

  it("company B cannot read or be refused about company A's run: the route answers 404 and the guard finds nothing", async () => {
    const r = await call(runDetail as Route, 'GET', `/api/payroll/runs/${runId}`, runId, { user: adminB, company: B });
    expect(r.statusCode).toBe(404);
    await pool.query("UPDATE payroll_run_headers SET pay_frequency = 'weekly' WHERE id = $1", [runId]);
    try {
      expect(await refusal('calculate', B)).toBeNull();
      expect(clauses(await refusal('calculate', A))).toEqual(['frequency']);
    } finally {
      await pool.query("UPDATE payroll_run_headers SET pay_frequency = 'monthly' WHERE id = $1", [runId]);
    }
  });
});

describe('clauses on columns and tables later releases add (rolled back)', () => {
  it('passes the monthly regular run as it is (no garnishee tables exist)', async () => {
    for (const action of ['calculate', 'approve', 'post', 'reopen', 'payslip', 'emp201', 'irp5', 'bank_file'] as const) {
      expect(await refusal(action), action).toBeNull();
    }
  });

  it('an unknown tax status (a PSP) is refused for approve, not for reopen', async () => {
    await inRolledBackTx(async (c) => {
      await c.query('ALTER TABLE payroll_employees DROP CONSTRAINT payroll_employees_tax_status_check');
      await c.query("UPDATE payroll_employees SET tax_status = 'personal_service_provider' WHERE id = $1", [monthlyEmp]);
    }, async () => {
      expect(clauses(await refusal('approve'))).toEqual(['tax_status']);
      expect(await refusal('reopen')).toBeNull();
    });
  });

  it('a defined-benefit factor is refused for costing, not for payslips; a km row and a rate multiplier are not (RI lifted them, 999t)', async () => {
    const assignment = `SELECT id FROM payroll_employee_components WHERE employee_id = '${monthlyEmp}'`;
    await inRolledBackTx(async (c: PoolClient) => {
      await c.query('ALTER TABLE payroll_employee_components ADD COLUMN db_member_category_factor numeric');
      await c.query(`UPDATE payroll_employee_components SET db_member_category_factor = 1.2 WHERE id IN (${assignment})`);
    }, async () => {
      expect(clauses(await refusal('calculate'))).toEqual(['assignment']);
      expect(clauses(await refusal('approve'))).toEqual(['assignment']);
      expect(await refusal('payslip')).toBeNull();
    });
    for (const prepare of [
      async (c: PoolClient) => { await c.query(`UPDATE payroll_employee_components SET quantity = 10, quantity_unit = 'km' WHERE id IN (${assignment})`); },
      async (c: PoolClient) => {
        await c.query(`UPDATE payroll_employee_components SET quantity = 10, quantity_unit = 'hour', rate_multiplier = 1.5 WHERE id IN (${assignment})`);
      },
    ]) {
      await inRolledBackTx(prepare, async () => {
        expect(await refusal('calculate')).toBeNull();
        expect(await refusal('approve')).toBeNull();
      });
    }
  });

  it('an active garnishee order is refused for costing; a cancelled one is not; a deduction on the run refuses reopen', async () => {
    await inRolledBackTx(async (c) => {
      await c.query('CREATE TABLE payroll_garnishee_orders (id uuid DEFAULT gen_random_uuid(), company_id uuid, employee_id uuid, status text)');
      await c.query('CREATE TABLE payroll_garnishee_deductions (id uuid DEFAULT gen_random_uuid(), run_id uuid, order_id uuid)');
      await c.query("INSERT INTO payroll_garnishee_orders (company_id, employee_id, status) VALUES ($1, $2, 'cancelled')", [A, monthlyEmp]);
    }, async () => {
      expect(await refusal('approve')).toBeNull();
      const client = als.getStore()!.client as PoolClient;
      await client.query("INSERT INTO payroll_garnishee_orders (company_id, employee_id, status) VALUES ($1, $2, 'active')", [A, monthlyEmp]);
      expect(clauses(await refusal('approve'))).toEqual(['garnishee_order']);
      expect(await refusal('reopen')).toBeNull();
      await client.query('INSERT INTO payroll_garnishee_deductions (run_id) VALUES ($1)', [runId]);
      expect(clauses(await refusal('reopen'))).toEqual(['garnishee_deduction']);
    });
  });
});
