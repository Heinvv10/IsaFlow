/**
 * Employee work terms under a concurrent writer (real routes, real Postgres). The window is opened deterministically:
 * straight after the route's read of the employee (what it judged the patch against), another connection commits an owner's change, as a
 * concurrent PATCH would. The writer that read first must (1) never log the owner's change a second time under its own
 * name, and (2) answer a refusal (400), not a 500 from the database CHECK, when the owner's change makes its patch
 * unreachable.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import employee from '../../pages/api/payroll/employees/[id]';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { cleanPayrollCompanies, routeCaller, seedPayrollCompany, type Route } from './w3-01-payroll.helpers';

const hooks = vi.hoisted(() => ({ afterFirstRead: null as null | (() => Promise<void>), fired: 0 }));

// Every statement goes to the real database untouched except the first plain read of payroll_employees (the route's own,
// before the service takes any lock), after which the hook runs once. Lazy: sql returns a LazyQuery, so only the matched statement is wrapped.
vi.mock('@/lib/neon', async (orig) => {
  const real = await orig<Record<string, unknown>>();
  const realSql = real.sql as ((s: TemplateStringsArray, ...v: unknown[]) => unknown) & Record<string, unknown>;
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    const hook = hooks.afterFirstRead;
    if (hook && /^\s*SELECT \* FROM payroll_employees/.test(text) && !text.includes('FOR UPDATE')) {
      hooks.afterFirstRead = null;
      return (async () => {
        const rows = await realSql(strings, ...values);
        hooks.fired += 1;
        await hook();
        return rows;
      })();
    }
    return realSql(strings, ...values);
  };
  return { ...real, sql: Object.assign(sql, realSql) };
});

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const company = crypto.randomUUID();
const owner = crypto.randomUUID();
const manager = crypto.randomUUID();
let call: ReturnType<typeof routeCaller>;
let mine = '';

const sign = (sub: string) => new SignJWT({ sub, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' })
  .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'Terms race co']);
  await seedPayrollCompany(pool, company);
  for (const [id, role] of [[owner, 'admin'], [manager, 'accountant']] as const) {
    await pool.query('INSERT INTO users(id,email,role,is_active) VALUES($1,$2,$3,true)', [id, `${id}@test.local`, role]);
  }
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'owner')", [company, owner]);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'manager')", [company, manager]);
  call = routeCaller({ [owner]: await sign(owner), [manager]: await sign(manager) }, { user: manager, company });
  mine = (await pool.query<{ id: string }>('SELECT id FROM payroll_employees WHERE company_id = $1 LIMIT 1', [company])).rows[0]!.id;
});

beforeEach(async () => {
  hooks.fired = 0;
  await pool.query("UPDATE payroll_employees SET pay_basis='monthly', hourly_rate=NULL, occupation=NULL, s18a_receipt_held=false WHERE id = $1", [mine]);
  await pool.query('DELETE FROM payroll_employee_history WHERE employee_id = $1', [mine]);
});

afterAll(async () => {
  try {
    await cleanPayrollCompanies(pool, [company]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [[owner, manager]]);
  } finally { await pool.end(); }
});

/** What an owner's PATCH of an hourly rate leaves behind, committed on another connection. */
async function ownersChange(): Promise<void> {
  await pool.query("UPDATE payroll_employees SET pay_basis='hourly', hourly_rate=150 WHERE id = $1", [mine]);
  await pool.query(
    `INSERT INTO payroll_employee_history (company_id, employee_id, field_name, old_value, new_value, effective_from, changed_by)
     VALUES ($1, $2, 'hourly_rate', NULL, '150', CURRENT_DATE, $3)`, [company, mine, owner]);
}
const patch = (user: string, body: Record<string, unknown>) =>
  call(employee as Route, 'PATCH', `/api/payroll/employees/${mine}`, mine, { body, user });
const history = async (field: string) => (await pool.query<{ changed_by: string }>(
  'SELECT changed_by FROM payroll_employee_history WHERE employee_id = $1 AND field_name = $2', [mine, field])).rows;

describe('a concurrent owner change during a manager PATCH', () => {
  it("is logged once, under the owner's name; the manager logs only the occupation they changed", async () => {
    hooks.afterFirstRead = ownersChange;
    const out = await patch(manager, { occupation: 'Fitter' });
    expect(hooks.fired, 'the race window was opened').toBe(1);
    expect(out.statusCode, JSON.stringify(out.body)).toBe(200);
    expect(await history('hourly_rate')).toEqual([{ changed_by: owner }]);
    expect(await history('occupation')).toEqual([{ changed_by: manager }]);
    const row = (await pool.query('SELECT pay_basis, hourly_rate::float AS hr, occupation FROM payroll_employees WHERE id = $1', [mine])).rows[0];
    expect(row).toEqual({ pay_basis: 'hourly', hr: 150, occupation: 'Fitter' });
  });

  it("a patch the owner's change made unreachable is a 400 and writes nothing, not a database 500", async () => {
    hooks.afterFirstRead = ownersChange;
    // Valid against the monthly row the route read; the owner then made the employee hourly, so clearing the rate is refused.
    const out = await patch(owner, { hourlyRate: null });
    expect(hooks.fired, 'the race window was opened').toBe(1);
    expect(out.statusCode, JSON.stringify(out.body)).toBe(400);
    const row = (await pool.query('SELECT pay_basis, hourly_rate::float AS hr FROM payroll_employees WHERE id = $1', [mine])).rows[0];
    expect(row).toEqual({ pay_basis: 'hourly', hr: 150 });
  });
});

describe('a concurrent s18A toggle during a PATCH', () => {
  const setTick = (v: boolean) => async () => { await pool.query('UPDATE payroll_employees SET s18a_receipt_held = $2 WHERE id = $1', [mine, v]); };
  const tick = async () => (await pool.query<{ t: boolean }>('SELECT s18a_receipt_held AS t FROM payroll_employees WHERE id = $1', [mine])).rows[0]!.t;

  it("a request for the value another writer just set leaves it set (nothing doubled)", async () => {
    hooks.afterFirstRead = setTick(true);
    expect((await patch(owner, { s18aReceiptHeld: true })).statusCode).toBe(200);
    expect(hooks.fired, 'the race window was opened').toBe(1);
    expect(await tick()).toBe(true);
  });

  it('a request to clear it, read as unchanged before the other writer set it, still clears it (nothing lost)', async () => {
    hooks.afterFirstRead = setTick(true);
    expect((await patch(owner, { s18aReceiptHeld: false })).statusCode).toBe(200);
    expect(hooks.fired, 'the race window was opened').toBe(1);
    expect(await tick()).toBe(false);
  });
});
