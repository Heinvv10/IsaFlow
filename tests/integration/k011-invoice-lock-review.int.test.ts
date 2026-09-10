/**
 * K-011 review findings — the invoice row lock, from the other side.
 *
 * MEDIUM 1: locking the invoice in the credit-note path only serialises credit
 * notes against each other. The other writer of `customer_invoices.amount_paid`
 * is a receipt allocation, whose cap (`receiptAllocationLines.buildLine`) was
 * computed from an unlocked read and whose money write is relative — so a
 * receipt that planned against the full outstanding still added its whole
 * amount on top of a credit note that committed in between.
 *
 * LOW 1: the invoice lock must wait on a budget, not forever, and must fail as
 * a typed retryable error rather than a bare 55P03.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { als } from '../../src/lib/als';
import {
  applyCreditNoteToInvoice,
  cancelCreditNote,
} from '../../src/modules/accounting/services/ar/creditNoteCancelService';
import {
  applyReceiptPlan,
  planReceiptApplication,
} from '../../src/modules/accounting/services/ar/receiptApplicationService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID(), user = crypto.randomUUID(), customer = crypto.randomUUID();
const invoice = crypto.randomUUID(), note = crypto.randomUUID(), payment = crypto.randomUUID();

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'K011 review fixture']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')", [company, user]);
  await pool.query('INSERT INTO customers(id,company_id,name) VALUES($1,$2,$3)', [customer, company, 'K011 review customer']);
});

beforeEach(async () => {
  await pool.query('DELETE FROM customer_payment_allocations WHERE payment_id=$1', [payment]);
  await pool.query('DELETE FROM customer_payments WHERE company_id=$1', [company]);
  await pool.query('DELETE FROM credit_notes WHERE company_id=$1', [company]);
  await pool.query('DELETE FROM customer_invoices WHERE company_id=$1', [company]);
  await pool.query(`INSERT INTO customer_invoices(id,company_id,invoice_number,customer_id,client_id,subtotal,total_amount,amount_paid,status,created_by,invoice_date)
    VALUES($1,$2,'K011-REV-1',$3,$3,200,200,0,'sent',$4,'2026-03-01')`, [invoice, company, customer, user]);
  await pool.query(`INSERT INTO credit_notes(id,company_id,type,client_id,credit_date,subtotal,total_amount,status,created_by,applied_amount)
    VALUES($1,$2,'customer',$3,'2026-03-02',100,100,'approved',$4,0)`, [note, company, customer, user]);
  await pool.query(`INSERT INTO customer_payments(id,company_id,payment_number,client_id,payment_date,total_amount,status,created_by)
    VALUES($1,$2,'K011-REC-1',$3,'2026-03-03',200,'confirmed',$4)`, [payment, company, customer, user]);
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM customer_payment_allocations WHERE payment_id=$1', [payment]);
    await pool.query('DELETE FROM customer_payments WHERE company_id=$1', [company]);
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
  throw new Error('the second request never blocked on the invoice row lock');
}

it('refuses a receipt that would over-apply an invoice a credit note took in the meantime', async () => {
  const noteTx = await beginRequest();
  const receiptTx = await beginRequest();
  let rejected: unknown;
  try {
    // The credit note takes the invoice and holds it, uncommitted.
    await asRequest(noteTx.client, () => applyCreditNoteToInvoice(company, note, invoice, user));

    // The receipt plans and applies R200 — the whole invoice as it stood when
    // this request started. Pre-fix it planned against the stale R200
    // outstanding and its relative write landed on top of the note's R100,
    // leaving amount_paid at R300 on a R200 invoice.
    const pending = asRequest(receiptTx.client, async () => {
      const plan = await planReceiptApplication(company, payment, [{ invoiceId: invoice, amount: 200 }]);
      return applyReceiptPlan(company, plan, user);
    }).catch((err: unknown) => { rejected = err; });

    await waitUntilBlocked(receiptTx.pid);
    await noteTx.client.query('COMMIT');
    await pending;
    await receiptTx.client.query(rejected ? 'ROLLBACK' : 'COMMIT');
  } finally { noteTx.client.release(); receiptTx.client.release(); }

  expect(String((rejected as Error | undefined)?.message))
    .toMatch(/R200\.00 exceeds the R100\.00 outstanding/);
  const inv = await pool.query('SELECT amount_paid::text AS paid FROM customer_invoices WHERE id=$1', [invoice]);
  expect(inv.rows[0].paid).toBe('100.00');
});

it('gives up on the invoice row after the lock budget and says to retry', async () => {
  const holder = await beginRequest();
  const waiter = await beginRequest();
  let caught: { name?: string; code?: string; message?: string } = {};
  try {
    await holder.client.query('SELECT id FROM customer_invoices WHERE id=$1 FOR UPDATE', [invoice]);
    const started = Date.now();
    try {
      await asRequest(waiter.client, () => applyCreditNoteToInvoice(company, note, invoice, user));
      throw new Error('the apply should not have acquired the invoice row');
    } catch (err) {
      caught = err as { name?: string; code?: string; message?: string };
    }
    // The wait is bounded by the 5s budget, not by the holder's lifetime.
    expect(Date.now() - started).toBeLessThan(15_000);
    await waiter.client.query('ROLLBACK');
    await holder.client.query('ROLLBACK');
  } finally { holder.client.release(); waiter.client.release(); }

  expect(caught.name).toBe('CustomerInvoiceLockTimeoutError');
  expect(caught.code).toBe('CUSTOMER_INVOICE_LOCK_TIMEOUT');
  expect(caught.message).toMatch(/retry in a moment/);
  const inv = await pool.query('SELECT amount_paid::text AS paid FROM customer_invoices WHERE id=$1', [invoice]);
  expect(inv.rows[0].paid).toBe('0.00');
}, 30_000);

it('leaves no lock budget behind for the rest of the request after a successful apply', async () => {
  const req = await beginRequest();
  let after = '';
  try {
    await asRequest(req.client, () => applyCreditNoteToInvoice(company, note, invoice, user));
    // `SET LOCAL` lasts to the end of the TRANSACTION. Leaving 5s in force
    // would silently govern the journal postings that follow in the same
    // request and surface a bare 55P03 nothing maps to a typed error.
    after = (await req.client.query('SHOW lock_timeout')).rows[0].lock_timeout as string;
    await req.client.query('COMMIT');
  } finally { req.client.release(); }
  expect(after).toBe('0');
});

it('bounds the cancel path\'s un-apply on the same budget and says to retry', async () => {
  // The cancel path moves `amount_paid` with a guarded UPDATE and never reads
  // the row first, so it takes the invoice lock through the statement itself.
  // Unbounded, it waited on the row for as long as the holder lived while this
  // request was already holding the credit note — one stuck request became two.
  const applyTx = await beginRequest();
  try {
    await asRequest(applyTx.client, () => applyCreditNoteToInvoice(company, note, invoice, user));
    await applyTx.client.query('COMMIT');
  } finally { applyTx.client.release(); }

  const holder = await beginRequest();
  const canceller = await beginRequest();
  let caught: { name?: string; code?: string; message?: string } = {};
  try {
    await holder.client.query('SELECT id FROM customer_invoices WHERE id=$1 FOR UPDATE', [invoice]);
    const started = Date.now();
    try {
      await asRequest(canceller.client, () => cancelCreditNote(company, note, user, 'test'));
      throw new Error('the cancel should not have acquired the invoice row');
    } catch (err) {
      caught = err as { name?: string; code?: string; message?: string };
    }
    expect(Date.now() - started).toBeLessThan(15_000);
    await canceller.client.query('ROLLBACK');
    await holder.client.query('ROLLBACK');
  } finally { holder.client.release(); canceller.client.release(); }

  expect(caught.name).toBe('CustomerInvoiceLockTimeoutError');
  expect(caught.code).toBe('CUSTOMER_INVOICE_LOCK_TIMEOUT');
  expect(caught.message).toMatch(/retry in a moment/);

  // The note is still applied and the invoice still carries its credit.
  //
  // The ROLLBACK above is this test's own. Production does the opposite: the
  // route answers 400 and `withAuth` COMMITs for any status under 500. The
  // outcome is still correct, but for a reason worth naming — 55P03 has already
  // ABORTED the transaction, so that COMMIT degenerates to a rollback and the
  // journal reversal issued earlier in `cancelCreditNote` cannot survive.
  //
  // That guarantee is specific to a Postgres error. It does NOT cover the
  // hand-thrown "invoice has less applied than this note credited" refusal
  // later in the same function, which runs on a live transaction after the
  // reversal has been written and so really does commit it. Pre-existing, out
  // of scope here, recorded in docs/audits/remediation/K-011/fix.md.
  const inv = await pool.query('SELECT amount_paid::text AS paid FROM customer_invoices WHERE id=$1', [invoice]);
  const cn = await pool.query('SELECT status, applied_amount::text AS applied FROM credit_notes WHERE id=$1', [note]);
  expect(inv.rows[0].paid).toBe('100.00');
  expect(cn.rows[0].status).toBe('applied');
  expect(cn.rows[0].applied).toBe('100.00');
}, 30_000);
