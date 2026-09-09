/**
 * K-011 adjacent cases for the invoice row lock in applyCreditNoteToInvoice.
 *
 * The serialisation added for the lost update must not weaken the two things
 * that surrounded it: the over-application cap, and tenant scoping. It must
 * also hold against the other writer of customer_invoices.amount_paid — a
 * receipt allocation — not just against a second credit note.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { als } from '../../src/lib/als';
import { applyCreditNoteToInvoice } from '../../src/modules/accounting/services/ar/creditNoteCancelService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID(), other = crypto.randomUUID(), user = crypto.randomUUID();
const customer = crypto.randomUUID(), invoice = crypto.randomUUID();
const big = crypto.randomUUID(), small = crypto.randomUUID();

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2),($3,$4)',
    [company, 'K011 adjacent fixture', other, 'K011 adjacent other tenant']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin'),($3,$2,'admin')", [company, user, other]);
  await pool.query('INSERT INTO customers(id,company_id,name) VALUES($1,$2,$3)', [customer, company, 'K011 adjacent customer']);
});

beforeEach(async () => {
  await pool.query('DELETE FROM credit_notes WHERE company_id=$1', [company]);
  await pool.query('DELETE FROM customer_invoices WHERE company_id=$1', [company]);
  await pool.query(`INSERT INTO customer_invoices(id,company_id,invoice_number,customer_id,client_id,subtotal,total_amount,amount_paid,status,created_by,invoice_date)
    VALUES($1,$2,'K011-ADJ-1',$3,$3,200,200,0,'sent',$4,'2026-03-01')`, [invoice, company, customer, user]);
  await pool.query(`INSERT INTO credit_notes(id,company_id,type,client_id,credit_date,subtotal,total_amount,status,created_by,applied_amount)
    VALUES($1,$3,'customer',$4,'2026-03-02',150,150,'approved',$5,0),($2,$3,'customer',$4,'2026-03-02',100,100,'approved',$5,0)`,
    [big, small, company, customer, user]);
});

afterAll(async () => {
  try {
    for (const c of [company, other]) {
      await pool.query('DELETE FROM credit_notes WHERE company_id=$1', [c]);
      await pool.query('DELETE FROM customer_invoices WHERE company_id=$1', [c]);
      await pool.query('DELETE FROM customers WHERE company_id=$1', [c]);
      await pool.query('DELETE FROM company_users WHERE company_id=$1', [c]);
      await pool.query('DELETE FROM companies WHERE id=$1', [c]);
    }
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

it('caps the second note at the outstanding balance the first one left', async () => {
  const first = await beginRequest();
  const second = await beginRequest();
  try {
    await asRequest(first.client, () => applyCreditNoteToInvoice(company, big, invoice, user));
    const pending = asRequest(second.client, () => applyCreditNoteToInvoice(company, small, invoice, user));
    await waitUntilBlocked(second.pid);
    await first.client.query('COMMIT');
    await pending;
    await second.client.query('COMMIT');
  } finally { first.client.release(); second.client.release(); }

  const inv = await pool.query('SELECT amount_paid::text AS paid, status FROM customer_invoices WHERE id=$1', [invoice]);
  const notes = await pool.query('SELECT id, applied_amount::text AS applied FROM credit_notes WHERE company_id=$1 ORDER BY total_amount DESC', [company]);
  // R150 then R100 against R200: the second is capped at the R50 left, and the
  // invoice is never credited beyond its own total.
  //
  // The R50 the second note could not absorb is STRANDED, and this assertion
  // records that rather than endorsing it. approveCreditNote already credited
  // AR with the note's full R100 (creditNoteApproveService.ts:62-63), while the
  // subledger moved R50 and the note is now 'applied', which the status guard
  // in applyCreditNoteToInvoice will not re-admit. GL and AR subledger diverge
  // by R50 permanently. Pre-existing and NOT fixed here: `credit_notes` holds
  // ONE `customer_invoice_id`, which is also how cancelCreditNote un-applies,
  // so letting a note span two invoices needs a link table. See
  // docs/audits/remediation/K-011/fix.md, "Open, not fixed here".
  expect(notes.rows.map(r => r.applied)).toEqual(['150.00', '50.00']);
  expect(inv.rows[0].paid).toBe('200.00');
  expect(inv.rows[0].status).toBe('paid');
});

it('does not erase a receipt allocation committed while the apply was in flight', async () => {
  const receipt = await beginRequest();
  const apply = await beginRequest();
  try {
    // A receipt allocation writes amount_paid the same way a payment does.
    await receipt.client.query(
      'UPDATE customer_invoices SET amount_paid = COALESCE(amount_paid,0) + 60 WHERE id=$1 AND company_id=$2',
      [invoice, company]);
    const pending = asRequest(apply.client, () => applyCreditNoteToInvoice(company, small, invoice, user));
    await waitUntilBlocked(apply.pid);
    await receipt.client.query('COMMIT');
    await pending;
    await apply.client.query('COMMIT');
  } finally { receipt.client.release(); apply.client.release(); }

  const inv = await pool.query('SELECT amount_paid::text AS paid FROM customer_invoices WHERE id=$1', [invoice]);
  const note = await pool.query('SELECT applied_amount::text AS applied FROM credit_notes WHERE id=$1', [small]);
  expect(note.rows[0].applied).toBe('100.00');
  expect(inv.rows[0].paid).toBe('160.00');
});

it('refuses a credit note belonging to another tenant and writes nothing', async () => {
  const req = await beginRequest();
  try {
    await expect(
      als.run({ client: req.client, userId: user, companyId: other, claims: {} },
        () => applyCreditNoteToInvoice(other, small, invoice, user))
    ).rejects.toThrow('Credit note not found');
    await req.client.query('COMMIT');
  } finally { req.client.release(); }

  const inv = await pool.query('SELECT amount_paid::text AS paid, status FROM customer_invoices WHERE id=$1', [invoice]);
  const note = await pool.query("SELECT status, applied_amount::text AS applied FROM credit_notes WHERE id=$1", [small]);
  expect(inv.rows[0].paid).toBe('0.00');
  expect(inv.rows[0].status).toBe('sent');
  expect(note.rows[0].status).toBe('approved');
  expect(note.rows[0].applied).toBe('0.00');
});
