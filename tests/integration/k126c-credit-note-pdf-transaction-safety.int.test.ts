/**
 * Round-2 LOW-7 — the credit-note PDF builder poisoned the request transaction.
 *
 * `credit_note_items` does not exist in the schema, so
 * `SELECT * FROM credit_note_items` raised 42P01 on EVERY call and a bare
 * `catch {}` swallowed it. The route runs under `withAuth`, which holds one
 * transaction per request on an AsyncLocalStorage client, so from that point
 * the transaction was aborted: any query added to the route afterwards would
 * fail with 25P02 naming nothing useful, and the COMMIT would find a dead
 * transaction. The builder now asks `to_regclass` instead, which never raises.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { als } from '../../src/lib/als';
import { sql } from '../../src/lib/neon';
import { generateCreditNotePdf } from '../../src/modules/accounting/services/ar/creditNotePdfBuilder';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID(), user = crypto.randomUUID(), customer = crypto.randomUUID();
const creditNote = crypto.randomUUID();

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name,is_active) VALUES($1,$2,true)', [company, 'K126c fixture']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await pool.query('INSERT INTO customers(id,company_id,name) VALUES($1,$2,$3)', [customer, company, 'K126c customer']);
  await pool.query(
    `INSERT INTO credit_notes(id,company_id,credit_note_number,type,client_id,credit_date,
                              subtotal,tax_rate,tax_amount,total_amount,status,created_by)
     VALUES($1,$2,'K126C-CN-1','customer',$3,'2026-01-01',100,15,15,115,'approved',$4)`,
    [creditNote, company, customer, user]);
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM credit_notes WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM customers WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=$1', [company]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

it('leaves the request transaction usable, and commits', async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const buf = await als.run(
      { client, userId: user, companyId: company, claims: {} },
      async () => {
        const pdf = await generateCreditNotePdf(company, creditNote);
        // The query a future edit to this route would add. Before the fix the
        // swallowed 42P01 had already aborted the transaction and this raised
        // 25P02 "current transaction is aborted".
        const rows = (await sql`SELECT 1 AS ok`) as Array<{ ok: number }>;
        expect(rows[0]!.ok).toBe(1);
        return pdf;
      },
    );

    expect(buf.length).toBeGreaterThan(0);
    // A poisoned transaction commits as ROLLBACK; this is the second half of
    // the same fact and the half a route silently depends on.
    await client.query('COMMIT');
  } finally {
    client.release();
  }
});

it('renders without a line-items table and still prints the totals block', async () => {
  const buf = await generateCreditNotePdf(company, creditNote);
  const text = [...buf.toString('latin1').matchAll(/\(((?:\\.|[^\\()])*)\)\s*Tj/g)]
    .map((m) => m[1]!.replace(/\\([()\\])/g, '$1'));

  expect(text).toContain('Subtotal');
  expect(text).toContain('VAT (15%)');
});

it('will not render another tenant\'s credit note', async () => {
  await expect(generateCreditNotePdf(crypto.randomUUID(), creditNote))
    .rejects.toThrow(/Credit note not found/);
});
