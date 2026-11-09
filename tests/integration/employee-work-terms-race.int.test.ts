/**
 * Employee work terms under a concurrent writer (real routes, real Postgres). The window is opened deterministically,
 * inside the service before its first locking statement: another connection commits an owner's change, as a
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

const hooks = vi.hoisted(() => ({ concurrentWriteInsideService: null as null | (() => Promise<void>), fired: 0 }));

// The window is opened inside the service, on whichever shape it has: the hook runs once, either right after the first
// statement updatePayrollEmployee issues through sql (a read before the lock) or, if that comes first, at the start of its
// withTransaction (before its first locking statement). Only calls made from updatePayrollEmployee count (the stack
// names it); everything else, the request's own statements and transactions included, goes through untouched.
vi.mock('@/lib/neon', async (orig) => {
  const real = await orig<Record<string, unknown>>();
  const realSql = real.sql as ((s: TemplateStringsArray, ...v: unknown[]) => unknown) & Record<string, unknown>;
  const realTx = real.withTransaction as <T>(fn: (tx: unknown) => Promise<T>, ...rest: unknown[]) => Promise<T>;
  const fromService = () => Boolean(new Error().stack?.includes('updatePayrollEmployee'));
  const take = () => {
    const hook = hooks.concurrentWriteInsideService;
    hooks.concurrentWriteInsideService = null;
    return hook;
  };
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    if (!hooks.concurrentWriteInsideService || !fromService()) return realSql(strings, ...values);
    const hook = take()!;
    return (async () => {
      const rows = await realSql(strings, ...values);
      hooks.fired += 1;
      await hook();
      return rows;
    })();
  };
  const withTransaction = <T,>(fn: (tx: unknown) => Promise<T>, ...rest: unknown[]): Promise<T> => {
    if (!hooks.concurrentWriteInsideService || !fromService()) return realTx(fn, ...rest);
    const hook = take()!;
    return realTx(async (tx) => {
      hooks.fired += 1;
      await hook();
      return fn(tx);
    }, ...rest);
  };
  return { ...real, sql: Object.assign(sql, realSql), withTransaction };
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
  hooks.concurrentWriteInsideService = null;
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
    hooks.concurrentWriteInsideService = ownersChange;
    const out = await patch(manager, { occupation: 'Fitter' });
    expect(hooks.fired, 'the race window was opened').toBe(1);
    expect(out.statusCode, JSON.stringify(out.body)).toBe(200);
    expect(await history('hourly_rate')).toEqual([{ changed_by: owner }]);
    expect(await history('occupation')).toEqual([{ changed_by: manager }]);
    const row = (await pool.query('SELECT pay_basis, hourly_rate::float AS hr, occupation FROM payroll_employees WHERE id = $1', [mine])).rows[0];
    expect(row).toEqual({ pay_basis: 'hourly', hr: 150, occupation: 'Fitter' });
  });

  it("a patch the owner's change made unreachable is a 400 and writes nothing, not a database 500", async () => {
    hooks.concurrentWriteInsideService = ownersChange;
    // Valid against the monthly row the route read; the owner then made the employee hourly, so clearing the rate is refused.
    const out = await patch(owner, { hourlyRate: null });
    expect(hooks.fired, 'the race window was opened').toBe(1);
    expect(out.statusCode, JSON.stringify(out.body)).toBe(400);
    const row = (await pool.query('SELECT pay_basis, hourly_rate::float AS hr FROM payroll_employees WHERE id = $1', [mine])).rows[0];
    expect(row).toEqual({ pay_basis: 'hourly', hr: 150 });
  });
});

describe('a concurrent rate change during an owner PATCH of the same rate', () => {
  it("records the change from the rate that was actually stored (150), not from the one the route read (100)", async () => {
    await pool.query("UPDATE payroll_employees SET pay_basis='hourly', hourly_rate=100 WHERE id = $1", [mine]);
    hooks.concurrentWriteInsideService = async () => {
      await pool.query('UPDATE payroll_employees SET hourly_rate=150 WHERE id = $1', [mine]);
      await pool.query(
        `INSERT INTO payroll_employee_history (company_id, employee_id, field_name, old_value, new_value, effective_from, changed_by)
         VALUES ($1, $2, 'hourly_rate', '100', '150', CURRENT_DATE, $3)`, [company, mine, owner]);
    };
    const out = await patch(owner, { hourlyRate: 200 });
    expect(hooks.fired, 'the race window was opened').toBe(1);
    expect(out.statusCode, JSON.stringify(out.body)).toBe(200);
    const rows = (await pool.query<{ old_value: string; new_value: string }>(
      "SELECT old_value, new_value FROM payroll_employee_history WHERE employee_id = $1 AND field_name = 'hourly_rate' ORDER BY new_value", [mine])).rows;
    expect(rows).toEqual([{ old_value: '100', new_value: '150' }, { old_value: '150', new_value: '200' }]);
  });
});

describe('a concurrent owner change during an owner PATCH that takes the company lock', () => {
  it('an hours change logs only the hours: the concurrent rate change is not logged a second time', async () => {
    hooks.concurrentWriteInsideService = ownersChange;
    const out = await patch(owner, { hoursPerWeek: 38 });
    expect(hooks.fired, 'the race window was opened').toBe(1);
    expect(out.statusCode, JSON.stringify(out.body)).toBe(200);
    expect(await history('hourly_rate')).toHaveLength(1);
    expect(await history('hours_per_week')).toHaveLength(1);
  });
});

describe('a concurrent s18A toggle during a PATCH', () => {
  const setTick = (v: boolean) => async () => { await pool.query('UPDATE payroll_employees SET s18a_receipt_held = $2 WHERE id = $1', [mine, v]); };
  const tick = async () => (await pool.query<{ t: boolean }>('SELECT s18a_receipt_held AS t FROM payroll_employees WHERE id = $1', [mine])).rows[0]!.t;

  it("a request for the value another writer just set leaves it set (nothing doubled)", async () => {
    hooks.concurrentWriteInsideService = setTick(true);
    expect((await patch(owner, { s18aReceiptHeld: true })).statusCode).toBe(200);
    expect(hooks.fired, 'the race window was opened').toBe(1);
    expect(await tick()).toBe(true);
  });

  it('a request to clear it, read as unchanged before the other writer set it, still clears it (nothing lost)', async () => {
    hooks.concurrentWriteInsideService = setTick(true);
    expect((await patch(owner, { s18aReceiptHeld: false })).statusCode).toBe(200);
    expect(hooks.fired, 'the race window was opened').toBe(1);
    expect(await tick()).toBe(false);
  });
});
