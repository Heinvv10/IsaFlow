/**
 * K-014 follow-up — the lock's blast radius on the bulk route.
 *
 * `lockSupplierInvoiceForUpdate` carries a 5s `lock_timeout`, and the 55P03 it
 * raises ABORTS the transaction. Since PR #264 the whole request — every id in
 * a bulk batch — is ONE transaction, and `withAuth` COMMITs on any response
 * under 500; PostgreSQL executes that COMMIT as ROLLBACK without raising. So a
 * single contended bill used to discard the entire batch while the route still
 * answered 200 with a success count for rows that no longer existed.
 *
 * Both tests drive the REAL route (withAuth → withCsrf → withWriteAccess →
 * handler) against real PostgreSQL, with a second pool client holding
 * `FOR UPDATE` on one of the two bills for longer than the lock timeout.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import bulkAction from '../../pages/api/accounting/supplier-invoices-bulk-action';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';

assertDisposable();

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const company = crypto.randomUUID();
const user = crypto.randomUUID();
const supplier = crypto.randomUUID();
const expenseAccount = crypto.randomUUID();
let token = '';

async function makeBill(number: string): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO supplier_invoices
       (id, company_id, supplier_id, invoice_number, invoice_date, subtotal,
        tax_rate, tax_amount, total_amount, status, created_by)
     VALUES ($1,$2,$3,$4,'2026-06-30',100,15,15,115,'approved',$5)`,
    [id, company, supplier, number, user],
  );
  await pool.query(
    `INSERT INTO supplier_invoice_items
       (supplier_invoice_id, description, quantity, unit_price, tax_rate,
        tax_amount, line_total, gl_account_id)
     VALUES ($1,'K014 bulk line',1,100,15,15,100,$2)`,
    [id, expenseAccount],
  );
  return id;
}

/** Holds FOR UPDATE on one bill until the returned release() is called. */
async function holdLock(invoiceId: string) {
  const client = await pool.connect();
  await client.query('BEGIN');
  await client.query('SELECT id FROM supplier_invoices WHERE id = $1 FOR UPDATE', [invoiceId]);
  return async () => {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  };
}

async function postGl(invoiceIds: string[]) {
  const req = request({ 'sb-access-token': token, active_company_id: company }, 'POST');
  req.url = '/api/accounting/supplier-invoices-bulk-action';
  req.body = { action: 'post_gl', invoiceIds };
  const result = response();
  await bulkAction(req, result.res);
  return result;
}

async function journalCount(number: string): Promise<number> {
  const rows = await pool.query(
    `SELECT count(*)::int AS n FROM gl_journal_entries
      WHERE company_id = $1 AND description = $2 AND source = 'auto_supplier_invoice'`,
    [company, `Supplier invoice ${number}`],
  );
  return rows.rows[0].n as number;
}

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'K014 bulk fixture']);
  await pool.query(
    "INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'viewer',true)",
    [user, `${user}@test.local`],
  );
  await pool.query(
    "INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')",
    [company, user],
  );
  await pool.query('INSERT INTO suppliers(id,company_id,name) VALUES($1,$2,$3)', [
    supplier, company, 'K014 bulk supplier',
  ]);
  const acct = async (id: string | null, code: string, name: string, type: string, sub: string, normal: string) =>
    pool.query(
      `INSERT INTO gl_accounts
         (id, company_id, account_code, account_name, account_type, account_subtype,
          normal_balance, is_active, is_system_account)
       VALUES (COALESCE($1::uuid, gen_random_uuid()),$2,$3,$4,$5,$6,$7,true,true)`,
      [id, company, code, name, type, sub, normal],
    );
  await acct(expenseAccount, '6000', 'K014 Expense', 'expense', 'default_expense', 'debit');
  await acct(null, '2100', 'K014 AP', 'liability', 'payable', 'credit');
  await acct(null, '2200', 'K014 VAT Input', 'asset', 'vat_input', 'debit');
  token = await new SignJWT({ sub: user, aal: 'aal2' })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(process.env.JWT_SECRET));
}, 60000);

afterAll(async () => {
  try {
    await pool.query('UPDATE supplier_invoices SET gl_journal_entry_id=NULL WHERE company_id=$1', [company]);
    await pool.query(
      'DELETE FROM supplier_invoice_items WHERE supplier_invoice_id IN (SELECT id FROM supplier_invoices WHERE company_id=$1)',
      [company],
    );
    await pool.query('DELETE FROM supplier_invoices WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_journal_lines WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_journal_entries WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM suppliers WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_account_balances WHERE gl_account_id IN (SELECT id FROM gl_accounts WHERE company_id=$1)', [company]);
    await pool.query('DELETE FROM gl_accounts WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM fiscal_periods WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM company_users WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=$1', [company]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally {
    await pool.end();
  }
}, 60000);

it('posts the uncontended bill when an earlier one in the batch times out on the lock', async () => {
  const numbers = { a: `K014-BULK-A1-${Date.now()}`, b: `K014-BULK-B1-${Date.now()}` };
  const ids = [await makeBill(numbers.a), await makeBill(numbers.b)];
  // The route processes ids sorted, so lock the one it reaches FIRST.
  const [firstId] = [...ids].sort();
  const numberOf = new Map([[ids[0]!, numbers.a], [ids[1]!, numbers.b]]);
  const contended = numberOf.get(firstId!)!;
  const other = contended === numbers.a ? numbers.b : numbers.a;

  const release = await holdLock(firstId!);
  let result;
  try {
    result = await postGl(ids);
  } finally {
    await release();
  }

  const body = result.state.body as { data: { succeeded: number; failed: number } };
  expect(result.state.statusCode).toBe(200);
  expect(body.data.failed).toBe(1);
  expect(body.data.succeeded).toBe(1);
  // The claim: the sibling's journal SURVIVED the contended bill's 55P03.
  expect(await journalCount(other)).toBe(1);
  expect(await journalCount(contended)).toBe(0);
}, 60000);

it('keeps a bill posted earlier in the batch when a later one times out', async () => {
  const numbers = { a: `K014-BULK-A2-${Date.now()}`, b: `K014-BULK-B2-${Date.now()}` };
  const ids = [await makeBill(numbers.a), await makeBill(numbers.b)];
  const sorted = [...ids].sort();
  const numberOf = new Map([[ids[0]!, numbers.a], [ids[1]!, numbers.b]]);
  const early = numberOf.get(sorted[0]!)!;
  const late = numberOf.get(sorted[1]!)!;

  // Lock the SECOND id: the first posts, then the batch aborts on the second.
  // Unfixed, the route reported succeeded:1 and committed nothing.
  const release = await holdLock(sorted[1]!);
  let result;
  try {
    result = await postGl(ids);
  } finally {
    await release();
  }

  const body = result.state.body as { data: { succeeded: number; failed: number } };
  expect(result.state.statusCode).toBe(200);
  expect(body.data.succeeded).toBe(1);
  expect(body.data.failed).toBe(1);
  // The reported success is real: the journal is in the ledger and balanced.
  expect(await journalCount(early)).toBe(1);
  expect(await journalCount(late)).toBe(0);
  const bal = await pool.query(
    `SELECT COALESCE(SUM(jl.debit),0)::float8 AS dr, COALESCE(SUM(jl.credit),0)::float8 AS cr
       FROM gl_journal_lines jl
       JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
      WHERE je.company_id = $1 AND je.description = $2`,
    [company, `Supplier invoice ${early}`],
  );
  expect(bal.rows[0].dr).toBeCloseTo(115, 2);
  expect(bal.rows[0].cr).toBeCloseTo(115, 2);
  const link = await pool.query(
    'SELECT gl_journal_entry_id FROM supplier_invoices WHERE company_id=$1 AND invoice_number=$2',
    [company, early],
  );
  expect(link.rows[0].gl_journal_entry_id).not.toBeNull();
}, 60000);
