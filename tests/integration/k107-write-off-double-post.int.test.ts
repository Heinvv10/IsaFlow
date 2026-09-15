/**
 * K-107 round 6, census survivor HIGH-2a — `writeOffService.approveWriteOff`.
 *
 * It read `woRows[0].status !== 'draft'` in JS and then posted DR Bad Debt /
 * CR AR (plus the VAT Act §22(3) recovery), added the write-off amount to the
 * invoice's `amount_paid`, and finally rewrote the write-off row with no status
 * predicate and its row count discarded. Two concurrent approvals credited AR
 * twice and marked the invoice paid against money written off once.
 *
 * Proved by OUTCOME — the AR account's movement — under two interleaved pool
 * clients AND two sequential attempts.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { als } from '../../src/lib/als';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import {
  approveWriteOff,
  WriteOffNotApprovableError,
} from '../../src/modules/accounting/services/ar/writeOffService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID(), user = crypto.randomUUID(), customer = crypto.randomUUID();
const arAccount = crypto.randomUUID(), expenseAccount = crypto.randomUUID(), vatOutput = crypto.randomUUID();

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

/** One draft write-off of the full 1150.00 balance of one 1150.00 invoice. */
async function seedWriteOff(): Promise<{ writeOff: string; invoice: string }> {
  const writeOff = crypto.randomUUID(), invoice = crypto.randomUUID();
  await pool.query(
    `INSERT INTO customer_invoices(id,company_id,customer_id,client_id,invoice_number,invoice_date,due_date,
                                   subtotal,tax_amount,total_amount,amount_paid,status,created_by)
     VALUES($1,$2,$3,$3,$4,'2026-03-01','2026-03-31',1000,150,1150,0,'approved',$5)`,
    [invoice, company, customer, `K107R6-INV-${invoice.slice(0, 8)}`, user]);
  await pool.query(
    `INSERT INTO customer_write_offs(id,company_id,write_off_number,client_id,invoice_id,amount,reason,
                                     write_off_date,status,created_by)
     VALUES($1,$2,$3,$4,$5,1150,'irrecoverable','2026-04-01','draft',$6)`,
    [writeOff, company, `K107R6-WRI-${writeOff.slice(0, 8)}`, customer, invoice, user]);
  return { writeOff, invoice };
}

/** What the AR control account actually moved, measured off posted lines. */
async function arCredited(): Promise<number> {
  const r = await pool.query(
    `SELECT COALESCE(SUM(jl.credit),0) AS c FROM gl_journal_lines jl
       JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
      WHERE je.company_id=$1 AND je.status='posted' AND jl.gl_account_id=$2`, [company, arAccount]);
  return Number(r.rows[0].c);
}

async function amountPaid(invoice: string): Promise<number> {
  const r = await pool.query('SELECT amount_paid FROM customer_invoices WHERE id=$1', [invoice]);
  return Number(r.rows[0].amount_paid);
}

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'K107 R6 write-off fixture']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await pool.query('INSERT INTO customers(id,company_id,name) VALUES($1,$2,$3)', [customer, company, 'K107 R6 customer']);
  await pool.query(
    `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,
                             is_system_account,is_active)
     VALUES($1,$2,'1200','Accounts Receivable','asset','receivable','debit',true,true),
            ($3,$2,'6100','Bad Debts','expense','admin_expense','debit',true,true),
            ($4,$2,'2200','VAT Output','liability','vat_output','credit',true,true)`,
    [arAccount, company, expenseAccount, vatOutput]);
});

afterAll(async () => {
  try {
    await pool.query('UPDATE customer_write_offs SET gl_journal_entry_id=NULL WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_journal_lines WHERE journal_entry_id IN (SELECT id FROM gl_journal_entries WHERE company_id=$1)', [company]);
    await pool.query('DELETE FROM gl_journal_entries WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM customer_write_offs WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM customer_invoices WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_account_balances WHERE gl_account_id IN (SELECT id FROM gl_accounts WHERE company_id=$1)', [company]);
    await pool.query('DELETE FROM gl_accounts WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM customers WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM fiscal_periods WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=$1', [company]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

it('credits AR ONCE when two requests approve the same write-off simultaneously', async () => {
  const { writeOff, invoice } = await seedWriteOff();
  const before = await arCredited();
  const a = await pool.connect(), b = await pool.connect();
  try {
    await a.query('BEGIN');
    await b.query('BEGIN');
    await als.run(ctxFor(a), () => approveWriteOff(company, writeOff, user));

    let settled = false;
    const attempt = als.run(ctxFor(b), () => approveWriteOff(company, writeOff, user));
    attempt.then(() => { settled = true; }, () => { settled = true; });
    await new Promise((r) => setTimeout(r, HOLD_MS));
    expect.soft(settled).toBe(false);

    await a.query('COMMIT');
    const loser = await attempt.then(() => null, (err: unknown) => err);
    await b.query('ROLLBACK');

    expect.soft(loser).toBeInstanceOf(WriteOffNotApprovableError);
    expect.soft((loser as WriteOffNotApprovableError).writeOffStatus).toBe('approved');
  } finally {
    a.release(); b.release();
  }

  expect.soft(await arCredited() - before).toBeCloseTo(1150, 2);
  expect.soft(await amountPaid(invoice)).toBeCloseTo(1150, 2);
  const row = await pool.query('SELECT status, gl_journal_entry_id, approved_by FROM customer_write_offs WHERE id=$1', [writeOff]);
  expect.soft(row.rows[0].status).toBe('approved');
  expect.soft(String(row.rows[0].approved_by)).toBe(user);
  expect(row.rows[0].gl_journal_entry_id).not.toBeNull();
});

it('refuses the SEQUENTIAL double-click, posting nothing the second time', async () => {
  const { writeOff, invoice } = await seedWriteOff();
  const before = await arCredited();
  await inTx(() => approveWriteOff(company, writeOff, user));

  const second = await inTx(() => approveWriteOff(company, writeOff, user))
    .then(() => null, (err: unknown) => err);
  expect.soft(second).toBeInstanceOf(WriteOffNotApprovableError);
  expect.soft((second as WriteOffNotApprovableError).writeOffStatus).toBe('approved');

  expect.soft(await arCredited() - before).toBeCloseTo(1150, 2);
  expect(await amountPaid(invoice)).toBeCloseTo(1150, 2);
});

it('posts a balanced journal whose AR credit equals the write-off, VAT recovered separately', async () => {
  const { writeOff, invoice } = await seedWriteOff();
  await inTx(() => approveWriteOff(company, writeOff, user));

  const je = await pool.query(
    `SELECT je.id, je.status, je.fiscal_period_id,
            COALESCE(SUM(jl.debit),0) AS dr, COALESCE(SUM(jl.credit),0) AS cr
       FROM gl_journal_entries je
       JOIN gl_journal_lines jl ON jl.journal_entry_id = je.id
       JOIN customer_write_offs wo ON wo.gl_journal_entry_id = je.id
      WHERE wo.id = $1
      GROUP BY je.id, je.status, je.fiscal_period_id`, [writeOff]);
  expect.soft(je.rowCount).toBe(1);
  expect.soft(je.rows[0].status).toBe('posted');
  expect.soft(je.rows[0].fiscal_period_id).not.toBeNull();
  expect.soft(Number(je.rows[0].dr)).toBeCloseTo(1150, 2);
  expect.soft(Number(je.rows[0].cr)).toBeCloseTo(1150, 2);

  // The AR leg equals the write-off, and equals what the invoice was relieved by.
  const legs = await pool.query(
    `SELECT jl.gl_account_id, jl.debit, jl.credit FROM gl_journal_lines jl
       JOIN customer_write_offs wo ON wo.gl_journal_entry_id = jl.journal_entry_id
      WHERE wo.id = $1`, [writeOff]);
  const ar = legs.rows.find((r) => String(r.gl_account_id) === arAccount);
  const vat = legs.rows.find((r) => String(r.gl_account_id) === vatOutput);
  expect.soft(Number(ar!.credit)).toBeCloseTo(1150, 2);
  expect.soft(Number(ar!.credit)).toBeCloseTo(await amountPaid(invoice), 2);
  expect(Number(vat!.debit)).toBeCloseTo(150, 2);
});

it('refuses a write-off that is already cancelled, before it posts anything', async () => {
  const { writeOff } = await seedWriteOff();
  await pool.query("UPDATE customer_write_offs SET status='cancelled' WHERE id=$1", [writeOff]);
  const before = await arCredited();

  const err = await inTx(() => approveWriteOff(company, writeOff, user)).then(() => null, (e: unknown) => e);
  expect.soft(err).toBeInstanceOf(WriteOffNotApprovableError);
  expect.soft((err as WriteOffNotApprovableError).writeOffStatus).toBe('cancelled');
  expect(await arCredited()).toBeCloseTo(before, 2);
});

it('will not approve a write-off belonging to another tenant', async () => {
  const otherCompany = crypto.randomUUID(), otherCustomer = crypto.randomUUID();
  const theirInvoice = crypto.randomUUID(), theirs = crypto.randomUUID();
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [otherCompany, 'K107 R6 write-off other']);
  await pool.query('INSERT INTO customers(id,company_id,name) VALUES($1,$2,$3)', [otherCustomer, otherCompany, 'other customer']);
  await pool.query(
    `INSERT INTO customer_invoices(id,company_id,customer_id,client_id,invoice_number,invoice_date,due_date,
                                   subtotal,tax_amount,total_amount,amount_paid,status,created_by)
     VALUES($1,$2,$3,$3,$4,'2026-03-01','2026-03-31',100,0,100,0,'approved',$5)`,
    [theirInvoice, otherCompany, otherCustomer, `K107R6-INV-OTHER-${theirInvoice.slice(0, 8)}`, user]);
  await pool.query(
    `INSERT INTO customer_write_offs(id,company_id,write_off_number,client_id,invoice_id,amount,reason,
                                     write_off_date,status,created_by)
     VALUES($1,$2,$3,$4,$5,100,'irrecoverable','2026-04-01','draft',$6)`,
    [theirs, otherCompany, `K107R6-WRI-OTHER-${theirs.slice(0, 8)}`, otherCustomer, theirInvoice, user]);

  const err = await inTx(() => approveWriteOff(company, theirs, user)).then(() => null, (e: unknown) => e);
  expect.soft((err as Error).message).toMatch(/Write-off not found/);
  const still = await pool.query('SELECT status, gl_journal_entry_id FROM customer_write_offs WHERE id=$1', [theirs]);
  expect.soft(still.rows[0].status).toBe('draft');
  expect(still.rows[0].gl_journal_entry_id).toBeNull();

  await pool.query('DELETE FROM customer_write_offs WHERE company_id=$1', [otherCompany]);
  await pool.query('DELETE FROM customer_invoices WHERE company_id=$1', [otherCompany]);
  await pool.query('DELETE FROM customers WHERE company_id=$1', [otherCompany]);
  await pool.query('DELETE FROM companies WHERE id=$1', [otherCompany]);
});
