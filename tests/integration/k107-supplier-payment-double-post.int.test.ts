/**
 * K-107 round 6, census survivor HIGH-1 — `processBatch`'s unfixed twin.
 *
 * `supplierPaymentWorkflowService.processSupplierPayment` read
 * `payment.status !== 'approved'` in JS and then created and POSTED a DR AP /
 * CR Bank journal for the full amount, incremented `amount_paid` on every
 * allocated bill, and finally rewrote the payment row with no status predicate
 * and its row count discarded. Two concurrent "process" clicks — the same
 * button `processBatch` has — credited the bank twice and overstated the
 * supplier ledger, with only one journal id surviving on the payment.
 *
 * The remedy is the one this branch already carries: a status-predicated claim
 * under a row lock, taken before the first posting, the loser refused with a
 * typed error. Proved by OUTCOME here — the bank GL, not the journal count —
 * under two interleaved pool clients AND two sequential attempts.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { als } from '../../src/lib/als';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import {
  processSupplierPayment,
  SupplierPaymentNotProcessableError,
} from '../../src/modules/accounting/services/ap/supplierPaymentWorkflowService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID(), user = crypto.randomUUID(), supplier = crypto.randomUUID();
const apAccount = crypto.randomUUID(), bankAccount = crypto.randomUUID();

/** How long the winner holds its transaction open while the loser is parked. */
const HOLD_MS = 300;

const ctxFor = (client: PoolClient) =>
  ({ client, userId: user, companyId: company, claims: {} } as unknown as Parameters<typeof als.run>[0]);

async function inTx<T>(fn: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await als.run(ctxFor(client), fn);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** One approved payment of 1150.00 allocated in full to one 1150.00 bill. */
async function seedPayment(): Promise<{ payment: string; invoice: string }> {
  const payment = crypto.randomUUID(), invoice = crypto.randomUUID();
  await pool.query(
    `INSERT INTO supplier_invoices(id,company_id,supplier_id,invoice_number,invoice_date,due_date,
                                   subtotal,tax_amount,total_amount,amount_paid,status,created_by)
     VALUES($1,$2,$3,$4,'2026-03-01','2026-03-31',1000,150,1150,0,'approved',$5)`,
    [invoice, company, supplier, `K107R6-BILL-${invoice.slice(0, 8)}`, user]);
  await pool.query(
    `INSERT INTO supplier_payments(id,company_id,supplier_id,payment_number,payment_date,total_amount,
                                   payment_method,status,created_by,bank_account_id)
     VALUES($1,$2,$3,$4,'2026-03-15',1150,'eft','approved',$5,$6)`,
    [payment, company, supplier, `K107R6-PAY-${payment.slice(0, 8)}`, user, bankAccount]);
  await pool.query(
    'INSERT INTO payment_allocations(payment_id,invoice_id,amount_allocated) VALUES($1,$2,1150)',
    [payment, invoice]);
  return { payment, invoice };
}

/**
 * What the BANK account actually moved, measured off posted journal lines —
 * not off a journal count, which a second posting under a different
 * description would slip past.
 */
async function bankCredited(): Promise<number> {
  const r = await pool.query(
    `SELECT COALESCE(SUM(jl.credit),0) AS c FROM gl_journal_lines jl
       JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
      WHERE je.company_id=$1 AND je.status='posted' AND jl.gl_account_id=$2`, [company, bankAccount]);
  return Number(r.rows[0].c);
}

async function amountPaid(invoice: string): Promise<number> {
  const r = await pool.query('SELECT amount_paid FROM supplier_invoices WHERE id=$1', [invoice]);
  return Number(r.rows[0].amount_paid);
}

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'K107 R6 payment fixture']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await pool.query('INSERT INTO suppliers(id,company_id,name) VALUES($1,$2,$3)', [supplier, company, 'K107 R6 supplier']);
  await pool.query(
    `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,
                             is_system_account,is_active)
     VALUES($1,$2,'2000','Accounts Payable','liability','payable','credit',true,true),
            ($3,$2,'1100','Bank','asset','bank','debit',true,true)`,
    [apAccount, company, bankAccount]);
});

afterAll(async () => {
  try {
    await pool.query('UPDATE supplier_payments SET gl_journal_entry_id=NULL WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_journal_lines WHERE journal_entry_id IN (SELECT id FROM gl_journal_entries WHERE company_id=$1)', [company]);
    await pool.query('DELETE FROM gl_journal_entries WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM payment_allocations WHERE payment_id IN (SELECT id FROM supplier_payments WHERE company_id=$1)', [company]);
    await pool.query('DELETE FROM supplier_payments WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM supplier_invoices WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_account_balances WHERE gl_account_id IN (SELECT id FROM gl_accounts WHERE company_id=$1)', [company]);
    await pool.query('DELETE FROM gl_accounts WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM suppliers WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM fiscal_periods WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=$1', [company]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

it('credits the bank ONCE when two requests process the same payment simultaneously', async () => {
  const { payment, invoice } = await seedPayment();
  const before = await bankCredited();
  const a = await pool.connect(), b = await pool.connect();
  try {
    await a.query('BEGIN');
    await b.query('BEGIN');
    await als.run(ctxFor(a), () => processSupplierPayment(company, payment, user));

    let settled = false;
    const attempt = als.run(ctxFor(b), () => processSupplierPayment(company, payment, user));
    attempt.then(() => { settled = true; }, () => { settled = true; });
    await new Promise((r) => setTimeout(r, HOLD_MS));
    // A holds the payment row: B is parked on the claim and cannot have decided
    // anything. Before the claim, B was past the status read by now and both
    // callers met at the per-company entry_number trigger instead — with no
    // lock_timeout on that path at all.
    expect.soft(settled).toBe(false);

    await a.query('COMMIT');
    const loser = await attempt.then(() => null, (err: unknown) => err);
    await b.query('ROLLBACK');

    expect.soft(loser).toBeInstanceOf(SupplierPaymentNotProcessableError);
    expect.soft((loser as SupplierPaymentNotProcessableError).paymentStatus).toBe('processed');
  } finally {
    a.release(); b.release();
  }

  expect.soft(await bankCredited() - before).toBeCloseTo(1150, 2);
  expect.soft(await amountPaid(invoice)).toBeCloseTo(1150, 2);
  const row = await pool.query('SELECT status, gl_journal_entry_id, processed_at FROM supplier_payments WHERE id=$1', [payment]);
  expect.soft(row.rows[0].status).toBe('processed');
  expect.soft(row.rows[0].processed_at).not.toBeNull();
  expect(row.rows[0].gl_journal_entry_id).not.toBeNull();
});

it('refuses the SEQUENTIAL double-click, posting nothing the second time', async () => {
  const { payment, invoice } = await seedPayment();
  const before = await bankCredited();
  await inTx(() => processSupplierPayment(company, payment, user));

  const second = await inTx(() => processSupplierPayment(company, payment, user))
    .then(() => null, (err: unknown) => err);
  expect.soft(second).toBeInstanceOf(SupplierPaymentNotProcessableError);
  expect.soft((second as SupplierPaymentNotProcessableError).paymentStatus).toBe('processed');

  expect.soft(await bankCredited() - before).toBeCloseTo(1150, 2);
  expect(await amountPaid(invoice)).toBeCloseTo(1150, 2);
});

it('posts a balanced journal agreeing with the payment total on the legitimate path', async () => {
  const { payment, invoice } = await seedPayment();
  await inTx(() => processSupplierPayment(company, payment, user));

  const je = await pool.query(
    `SELECT je.id, je.status, je.fiscal_period_id,
            COALESCE(SUM(jl.debit),0) AS dr, COALESCE(SUM(jl.credit),0) AS cr
       FROM gl_journal_entries je
       JOIN gl_journal_lines jl ON jl.journal_entry_id = je.id
       JOIN supplier_payments p ON p.gl_journal_entry_id = je.id
      WHERE p.id = $1
      GROUP BY je.id, je.status, je.fiscal_period_id`, [payment]);
  expect.soft(je.rowCount).toBe(1);
  expect.soft(je.rows[0].status).toBe('posted');
  expect.soft(je.rows[0].fiscal_period_id).not.toBeNull();
  expect.soft(Number(je.rows[0].dr)).toBeCloseTo(1150, 2);
  expect.soft(Number(je.rows[0].cr)).toBeCloseTo(1150, 2);
  expect.soft(Number(je.rows[0].dr)).toBeCloseTo(await amountPaid(invoice), 2);

  const paid = await pool.query('SELECT status FROM supplier_invoices WHERE id=$1', [invoice]);
  expect(paid.rows[0].status).toBe('paid');
});

it('refuses a payment that was never approved, before it posts anything', async () => {
  const { payment } = await seedPayment();
  await pool.query("UPDATE supplier_payments SET status='draft' WHERE id=$1", [payment]);
  const before = await bankCredited();

  const err = await inTx(() => processSupplierPayment(company, payment, user))
    .then(() => null, (e: unknown) => e);
  expect.soft(err).toBeInstanceOf(SupplierPaymentNotProcessableError);
  expect.soft((err as SupplierPaymentNotProcessableError).paymentStatus).toBe('draft');
  expect(await bankCredited()).toBeCloseTo(before, 2);
});

it('will not process a payment belonging to another tenant', async () => {
  const otherCompany = crypto.randomUUID(), otherSupplier = crypto.randomUUID();
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [otherCompany, 'K107 R6 payment other']);
  await pool.query('INSERT INTO suppliers(id,company_id,name) VALUES($1,$2,$3)', [otherSupplier, otherCompany, 'other supplier']);
  const theirs = crypto.randomUUID();
  await pool.query(
    `INSERT INTO supplier_payments(id,company_id,supplier_id,payment_number,payment_date,total_amount,
                                   payment_method,status,created_by)
     VALUES($1,$2,$3,$4,'2026-03-15',500,'eft','approved',$5)`,
    [theirs, otherCompany, otherSupplier, `K107R6-PAY-OTHER-${theirs.slice(0, 8)}`, user]);

  const err = await inTx(() => processSupplierPayment(company, theirs, user)).then(() => null, (e: unknown) => e);
  expect.soft((err as Error).message).toMatch(/not found/);
  const still = await pool.query('SELECT status, gl_journal_entry_id FROM supplier_payments WHERE id=$1', [theirs]);
  expect.soft(still.rows[0].status).toBe('approved');
  expect(still.rows[0].gl_journal_entry_id).toBeNull();

  await pool.query('DELETE FROM supplier_payments WHERE company_id=$1', [otherCompany]);
  await pool.query('DELETE FROM suppliers WHERE company_id=$1', [otherCompany]);
  await pool.query('DELETE FROM companies WHERE id=$1', [otherCompany]);
});
