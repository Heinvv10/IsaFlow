/**
 * 899/900 — customer_invoices.amount_paid may not exceed the invoice total.
 *
 * Audit 2026-10-18 (ar-receivables): every over-application guard is a
 * read-then-write in the service layer, so two concurrent applications can
 * each pass their own check and together push amount_paid past total_amount.
 * The CHECK is the database barrier underneath them. These cases assert the
 * OUTCOME as app_user (RLS on, real claims): what the row holds afterwards,
 * not which error was raised.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { createUser, newCompany } from './r035-approval.helpers';
import { insertPreConstraintRow } from './helpers/preConstraintRow';
import { liftAmountPaidCheck, restoreAmountPaidCheck } from './helpers/amountPaidCheck';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let user = '';

beforeAll(async () => { user = await createUser(pool, tokens); });
afterAll(async () => {
  await pool.query('DELETE FROM customer_invoices WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM customers WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM company_users WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM companies WHERE id = ANY($1)', [companies]);
  await pool.query('DELETE FROM users WHERE id = $1', [user]);
  await pool.end();
});

/** `fn` as app_user with the caller's request claims and the company GUC, committed. */
async function asApp<T>(company: string, fn: (db: PoolClient) => Promise<T>): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: user, session_id: crypto.randomUUID() })]);
    await db.query("SELECT set_config('app.current_company_id', $1, true)", [company]);
    await db.query('SET LOCAL ROLE app_user');
    const out = await fn(db);
    await db.query('COMMIT');
    return out;
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  } finally { db.release(); }
}
const outcome = async (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string }) => `${e.code}`);

async function invoice(total: number, paid = 0, opts: { preConstraint?: boolean } = {}) {
  const company = await newCompany(pool, [[user, 'admin']], companies);
  const customer = (await pool.query('INSERT INTO customers(company_id,name) VALUES($1,$2) RETURNING id', [company, 'AR check customer'])).rows[0].id as string;
  const id = crypto.randomUUID();
  const sqlText = `INSERT INTO customer_invoices(id,company_id,client_id,customer_id,invoice_number,invoice_date,due_date,status,total_amount,amount_paid,created_by)
     VALUES($1,$2,$3,$3,'CHK-1','2026-02-01','2026-03-01','approved',$4,$5,$6)`;
  if (opts.preConstraint) await insertPreConstraintRow(pool, sqlText, [id, company, customer, total, paid, user]);
  else await pool.query(sqlText, [id, company, customer, total, paid, user]);
  return { id, company };
}
const paidOf = async (id: string) => Number((await pool.query('SELECT amount_paid FROM customer_invoices WHERE id = $1', [id])).rows[0].amount_paid);

describe('customer_invoices_amount_paid_within_total', () => {
  it('an app_user UPDATE past the total errors and leaves the row unchanged', async () => {
    const inv = await invoice(100, 40);
    const result = await outcome(asApp(inv.company, (db) =>
      db.query('UPDATE customer_invoices SET amount_paid = 100.01 WHERE id = $1 AND company_id = $2', [inv.id, inv.company])));
    expect(await paidOf(inv.id)).toBe(40);
    expect(result).toBe('23514');
  });

  it('an additive application that would overshoot is refused and nothing is applied', async () => {
    const inv = await invoice(100, 60);
    const result = await outcome(asApp(inv.company, (db) =>
      db.query('UPDATE customer_invoices SET amount_paid = COALESCE(amount_paid, 0) + 50 WHERE id = $1 AND company_id = $2', [inv.id, inv.company])));
    expect(await paidOf(inv.id)).toBe(60);
    expect(result).toBe('23514');
  });

  it('paying exactly the total is allowed', async () => {
    const inv = await invoice(100, 40);
    expect(await outcome(asApp(inv.company, (db) =>
      db.query('UPDATE customer_invoices SET amount_paid = 100 WHERE id = $1 AND company_id = $2', [inv.id, inv.company])))).toBe('ok');
    expect(await paidOf(inv.id)).toBe(100);
  });

  it('is not role dependent: the pool/owner connection is refused too, and NaN is refused', async () => {
    const inv = await invoice(100, 0);
    expect(await outcome(pool.query('UPDATE customer_invoices SET amount_paid = 150 WHERE id = $1', [inv.id]))).toBe('23514');
    expect(await outcome(pool.query("UPDATE customer_invoices SET amount_paid = 'NaN' WHERE id = $1", [inv.id]))).toBe('23514');
    expect(await paidOf(inv.id)).toBe(0);
  });

  it('a legacy negative-total invoice at amount_paid 0 can still be edited and cancelled', async () => {
    const inv = await invoice(-115, 0, { preConstraint: true });
    expect(await outcome(asApp(inv.company, (db) =>
      db.query("UPDATE customer_invoices SET status = 'cancelled', deleted_at = NOW() WHERE id = $1 AND company_id = $2", [inv.id, inv.company])))).toBe('ok');
    expect((await pool.query('SELECT status FROM customer_invoices WHERE id = $1', [inv.id])).rows[0].status).toBe('cancelled');
    // ...but a negative total still cannot carry a payment.
    expect(await outcome(pool.query('UPDATE customer_invoices SET amount_paid = 1 WHERE id = $1', [inv.id]))).toBe('23514');
    expect(await paidOf(inv.id)).toBe(0);
  });

  it('the lift helper drops the CHECK only around the seed: a later write is still refused, restore validates and is idempotent', async () => {
    const seeded = await invoice(100, 0);
    const other = await invoice(100, 0);
    try {
      await liftAmountPaidCheck(() => pool.query('UPDATE customer_invoices SET amount_paid = 150 WHERE id = $1', [seeded.id]));
      expect(await paidOf(seeded.id)).toBe(150);
      // Back on, NOT VALID: the real write paths a suite then drives are still guarded.
      const state = await pool.query("SELECT convalidated FROM pg_constraint WHERE conname = 'customer_invoices_amount_paid_within_total'");
      expect(state.rows).toEqual([{ convalidated: false }]);
      expect(await outcome(pool.query('UPDATE customer_invoices SET amount_paid = 150 WHERE id = $1', [other.id]))).toBe('23514');
      expect(await paidOf(other.id)).toBe(0);
      // The impossible row left behind makes the validating restore fail loudly...
      await expect(restoreAmountPaidCheck()).rejects.toMatchObject({ code: '23514' });
      // ...even when a seed throws, the constraint is put back.
      await expect(liftAmountPaidCheck(async () => { throw new Error('seed failed'); })).rejects.toThrow('seed failed');
    } finally {
      await pool.query('DELETE FROM customer_invoices WHERE id = ANY($1)', [[seeded.id]]);
      await restoreAmountPaidCheck();
    }
    await restoreAmountPaidCheck();
    expect(await outcome(pool.query('UPDATE customer_invoices SET amount_paid = 150 WHERE id = $1', [other.id]))).toBe('23514');
  });

  it('the constraint is validated (900 ran) so it also covers rows that existed before 899', async () => {
    const r = await pool.query(
      "SELECT convalidated FROM pg_constraint WHERE conname = 'customer_invoices_amount_paid_within_total' AND conrelid = 'public.customer_invoices'::regclass");
    expect(r.rows).toEqual([{ convalidated: true }]);
  });
});
