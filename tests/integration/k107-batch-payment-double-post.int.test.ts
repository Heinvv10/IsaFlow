/**
 * K-107 round 5 census, class (b) — the check-then-act that moved money.
 *
 * `batchPaymentService.processBatch` read `batch.status !== 'approved'` and then
 * created and POSTED a DR AP / CR Bank journal for the whole batch, incremented
 * `amount_paid` on every invoice in it, and finally rewrote the batch row with
 * `WHERE id = $1` — no status predicate, no company_id, no lock. Two concurrent
 * "process" clicks both passed the read: two posted journals, the bank credited
 * twice, the supplier ledger overstated by the batch total, and only one journal
 * id surviving on the batch to show for it.
 *
 * Same remedy as the rest of this branch: a status-predicated claim under a row
 * lock, taken before the first posting, with the loser refused by a typed error.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { als } from '../../src/lib/als';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import {
  BatchNotProcessableError,
  processBatch,
} from '../../src/modules/accounting/services/ap/batchPaymentService';

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

/** One approved batch of one payment allocated in full to one 1150.00 bill. */
async function seedBatch(): Promise<{ batch: string; invoice: string }> {
  const batch = crypto.randomUUID(), payment = crypto.randomUUID(), invoice = crypto.randomUUID();
  await pool.query(
    `INSERT INTO supplier_invoices(id,company_id,supplier_id,invoice_number,invoice_date,due_date,
                                   subtotal,tax_amount,total_amount,amount_paid,status,created_by)
     VALUES($1,$2,$3,$4,'2026-03-01','2026-03-31',1000,150,1150,0,'approved',$5)`,
    [invoice, company, supplier, `K107R5-BILL-${invoice.slice(0, 8)}`, user]);
  await pool.query(
    `INSERT INTO supplier_payment_batches(id,company_id,batch_number,batch_date,total_amount,
                                          payment_count,payment_method,bank_account_id,status,created_by)
     VALUES($1,$2,$3,'2026-03-15',1150,1,'eft',$4,'approved',$5)`,
    [batch, company, `K107R5-BAT-${batch.slice(0, 8)}`, bankAccount, user]);
  await pool.query(
    `INSERT INTO supplier_payments(id,company_id,supplier_id,payment_date,total_amount,
                                   payment_method,status,batch_id,created_by)
     VALUES($1,$2,$3,'2026-03-15',1150,'eft','approved',$4,$5)`,
    [payment, company, supplier, batch, user]);
  await pool.query(
    'INSERT INTO payment_allocations(payment_id,invoice_id,amount_allocated) VALUES($1,$2,1150)',
    [payment, invoice]);
  return { batch, invoice };
}

async function journalsFor(batchNumberLike: string): Promise<number> {
  const r = await pool.query(
    `SELECT count(*)::int AS n FROM gl_journal_entries
      WHERE company_id=$1 AND description LIKE $2`, [company, batchNumberLike]);
  return Number(r.rows[0].n);
}

async function amountPaid(invoice: string): Promise<number> {
  const r = await pool.query('SELECT amount_paid FROM supplier_invoices WHERE id=$1', [invoice]);
  return Number(r.rows[0].amount_paid);
}

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'K107 R5 batch fixture']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await pool.query('INSERT INTO suppliers(id,company_id,name) VALUES($1,$2,$3)', [supplier, company, 'K107 batch supplier']);
  await pool.query(
    `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,
                             is_system_account,is_active)
     VALUES($1,$2,'2000','Accounts Payable','liability','payable','credit',true,true),
            ($3,$2,'1100','Bank','asset','bank','debit',true,true)`,
    [apAccount, company, bankAccount]);
});

afterAll(async () => {
  try {
    await pool.query('UPDATE supplier_payment_batches SET gl_journal_entry_id=NULL WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_journal_lines WHERE journal_entry_id IN (SELECT id FROM gl_journal_entries WHERE company_id=$1)', [company]);
    await pool.query('DELETE FROM gl_journal_entries WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM payment_allocations WHERE payment_id IN (SELECT id FROM supplier_payments WHERE company_id=$1)', [company]);
    await pool.query('DELETE FROM supplier_payments WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM supplier_payment_batches WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM supplier_invoices WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_account_balances WHERE gl_account_id IN (SELECT id FROM gl_accounts WHERE company_id=$1)', [company]);
    await pool.query('DELETE FROM gl_accounts WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM suppliers WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM fiscal_periods WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=$1', [company]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

it('posts ONE journal when two requests process the same batch simultaneously', async () => {
  const { batch, invoice } = await seedBatch();
  const like = `%${batch.slice(0, 8)}%`;
  const a = await pool.connect(), b = await pool.connect();
  try {
    await a.query('BEGIN');
    await b.query('BEGIN');
    await als.run(ctxFor(a), () => processBatch(company, batch, user));

    let settled = false;
    const attempt = als.run(ctxFor(b), () => processBatch(company, batch, user));
    attempt.then(() => { settled = true; }, () => { settled = true; });
    await new Promise((r) => setTimeout(r, HOLD_MS));
    // A holds the batch row: B is parked on the claim and cannot have decided
    // anything. Without the claim it would already have posted a second journal.
    expect.soft(settled).toBe(false);

    await a.query('COMMIT');
    const loser = await attempt.then(() => null, (err: unknown) => err);
    await b.query('ROLLBACK');

    expect.soft(loser).toBeInstanceOf(BatchNotProcessableError);
    expect.soft((loser as BatchNotProcessableError).batchStatus).toBe('processed');
  } finally {
    a.release(); b.release();
  }

  // One journal, and the bill paid once — not 2300.00 against a 1150.00 bill.
  expect.soft(await journalsFor(like)).toBe(1);
  expect.soft(await amountPaid(invoice)).toBeCloseTo(1150, 2);
  const row = await pool.query(
    'SELECT status, gl_journal_entry_id, processed_by FROM supplier_payment_batches WHERE id=$1', [batch]);
  expect.soft(row.rows[0].status).toBe('processed');
  expect.soft(String(row.rows[0].processed_by)).toBe(user);
  expect(row.rows[0].gl_journal_entry_id).not.toBeNull();
});

it('refuses the double-click retry, posting nothing the second time', async () => {
  const { batch, invoice } = await seedBatch();
  const like = `%${batch.slice(0, 8)}%`;
  await inTx(() => processBatch(company, batch, user));

  const second = await inTx(() => processBatch(company, batch, user))
    .then(() => null, (err: unknown) => err);
  expect.soft(second).toBeInstanceOf(BatchNotProcessableError);
  expect.soft((second as BatchNotProcessableError).batchStatus).toBe('processed');

  expect.soft(await journalsFor(like)).toBe(1);
  expect(await amountPaid(invoice)).toBeCloseTo(1150, 2);
});

it('posts a balanced journal that agrees with the batch total on the legitimate path', async () => {
  const { batch, invoice } = await seedBatch();
  await inTx(() => processBatch(company, batch, user));

  const je = await pool.query(
    `SELECT je.id, je.status,
            COALESCE(SUM(jl.debit),0) AS dr, COALESCE(SUM(jl.credit),0) AS cr
       FROM gl_journal_entries je
       JOIN gl_journal_lines jl ON jl.journal_entry_id = je.id
       JOIN supplier_payment_batches b ON b.gl_journal_entry_id = je.id
      WHERE b.id = $1
      GROUP BY je.id, je.status`, [batch]);
  expect.soft(je.rowCount).toBe(1);
  // Balanced, and equal to the batch total, which equals what the bill was paid.
  expect.soft(Number(je.rows[0].dr)).toBeCloseTo(1150, 2);
  expect.soft(Number(je.rows[0].cr)).toBeCloseTo(1150, 2);
  expect.soft(Number(je.rows[0].dr)).toBeCloseTo(await amountPaid(invoice), 2);

  const paid = await pool.query('SELECT status FROM supplier_invoices WHERE id=$1', [invoice]);
  expect(paid.rows[0].status).toBe('paid');
});

it('will not process a batch belonging to another tenant', async () => {
  const otherCompany = crypto.randomUUID();
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [otherCompany, 'K107 R5 batch other']);
  const theirs = crypto.randomUUID();
  await pool.query(
    `INSERT INTO supplier_payment_batches(id,company_id,batch_number,batch_date,total_amount,
                                          payment_count,payment_method,status,created_by)
     VALUES($1,$2,$3,'2026-03-15',500,1,'eft','approved',$4)`,
    [theirs, otherCompany, `K107R5-BAT-OTHER-${theirs.slice(0, 8)}`, user]);

  const err = await inTx(() => processBatch(company, theirs, user)).then(() => null, (e: unknown) => e);
  expect.soft((err as Error).message).toMatch(/Batch not found/);
  const still = await pool.query('SELECT status, gl_journal_entry_id FROM supplier_payment_batches WHERE id=$1', [theirs]);
  expect.soft(still.rows[0].status).toBe('approved');
  expect(still.rows[0].gl_journal_entry_id).toBeNull();

  await pool.query('DELETE FROM supplier_payment_batches WHERE company_id=$1', [otherCompany]);
  await pool.query('DELETE FROM companies WHERE id=$1', [otherCompany]);
});
