/**
 * K-011 — applyCreditNoteToInvoice writes an absolute amount_paid from a read
 * it never locked.
 *
 * The credit NOTE is locked (creditNoteCancelService.ts:140), but the INVOICE
 * is read with a plain SELECT (:145) and amount_paid is written as
 * `Number(inv.amount_paid) + applyAmount` (:159-164). Two different approved
 * notes applied to the same invoice by two overlapping requests both read the
 * same starting balance, so the second write erases the first.
 *
 * The interleave is real, not simulated: each call runs in its own request
 * transaction on its own pool client, exactly as withAuth would, and the test
 * waits until the second transaction is genuinely blocked on the first's row
 * lock before committing.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { als } from '../../src/lib/als';
import { applyCreditNoteToInvoice } from '../../src/modules/accounting/services/ar/creditNoteCancelService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID(), user = crypto.randomUUID(), customer = crypto.randomUUID();
const invoice = crypto.randomUUID(), noteA = crypto.randomUUID(), noteB = crypto.randomUUID();

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'K011 credit note fixture']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')", [company, user]);
  await pool.query('INSERT INTO customers(id,company_id,name) VALUES($1,$2,$3)', [customer, company, 'K011 customer']);
  await pool.query(`INSERT INTO customer_invoices(id,company_id,invoice_number,customer_id,client_id,subtotal,total_amount,amount_paid,status,created_by,invoice_date)
    VALUES($1,$2,'K011-INV-1',$3,$3,200,200,0,'sent',$4,'2026-03-01')`, [invoice, company, customer, user]);
  await pool.query(`INSERT INTO credit_notes(id,company_id,type,client_id,credit_date,subtotal,total_amount,status,created_by,applied_amount)
    VALUES($1,$3,'customer',$4,'2026-03-02',100,100,'approved',$5,0),($2,$3,'customer',$4,'2026-03-02',50,50,'approved',$5,0)`,
    [noteA, noteB, company, customer, user]);
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM credit_notes WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM customer_invoices WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM customers WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM company_users WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=$1', [company]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

async function beginRequest(): Promise<{ client: PoolClient; pid: number }> {
  const client = await pool.connect();
  await client.query('BEGIN');
  const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
  return { client, pid };
}
function asRequest<T>(client: PoolClient, fn: () => Promise<T>) {
  return als.run({ client, userId: user, companyId: company, claims: {} }, fn);
}
async function waitUntilBlocked(pid: number) {
  for (let i = 0; i < 300; i++) {
    const { rows } = await pool.query(
      "SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1 AND state='active'", [pid]);
    if (rows[0]?.wait_event_type === 'Lock') return;
    await new Promise(r => setTimeout(r, 20));
  }
  throw new Error('second request never blocked on the invoice row lock');
}

it('applies both credit notes without one erasing the other', async () => {
  const first = await beginRequest();
  const second = await beginRequest();
  try {
    await asRequest(first.client, () => applyCreditNoteToInvoice(company, noteA, invoice, user));

    const pending = asRequest(second.client, () => applyCreditNoteToInvoice(company, noteB, invoice, user));
    await waitUntilBlocked(second.pid);

    await first.client.query('COMMIT');
    await pending;
    await second.client.query('COMMIT');
  } finally {
    first.client.release();
    second.client.release();
  }

  const inv = await pool.query('SELECT amount_paid::text AS paid,status FROM customer_invoices WHERE id=$1', [invoice]);
  const notes = await pool.query("SELECT sum(applied_amount)::text AS applied FROM credit_notes WHERE company_id=$1 AND status='applied'", [company]);
  expect(notes.rows[0].applied).toBe('150.00');
  expect(inv.rows[0].paid).toBe('150.00');
});
