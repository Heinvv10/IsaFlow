/**
 * K-124 round-4 review — M-3 and L-3.
 *
 * M-3: resolveDispute read the dispute's status and then updated on id alone.
 * Two concurrent resolves (the UI racing an MCP call) both saw 'open', both
 * raised a credit note for the same disputed amount, and the second UPDATE
 * overwrote credit_note_id — leaving one real financial document orphaned and
 * invisible from the dispute. Detected by OUTCOME: two credit_notes rows for
 * one customer_invoice_id.
 *
 * L-3: the VAT split rounded subtotal and tax independently, so a gross of
 * 10.00 at 15% became 8.70 + 1.31 = 10.01 and relieved the debtor by a cent
 * more than the disputed amount.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { resolveDispute } from '../../src/modules/accounting/services/ar/disputeService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID(), user = crypto.randomUUID(), customer = crypto.randomUUID();
const invoice = crypto.randomUUID(), raced = crypto.randomUUID(), cent = crypto.randomUUID();
// One open dispute per invoice (ux_cust_inv_disputes_whole_open), so the
// cent-rounding case needs an invoice of its own.
const centInvoice = crypto.randomUUID();

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'K124b fixture']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await pool.query('INSERT INTO customers(id,company_id,name) VALUES($1,$2,$3)', [customer, company, 'K124b customer']);
  await pool.query(
    `INSERT INTO customer_invoices(id,company_id,invoice_number,customer_id,client_id,invoice_date,due_date,subtotal,tax_amount,total_amount,status,created_by)
     VALUES($1,$2,'K124B-INV',$3,$3,'2026-01-01','2026-01-31',1000,150,1150,'approved',$4)`,
    [invoice, company, customer, user]);
  await pool.query(
    `INSERT INTO customer_invoice_disputes(id,company_id,customer_invoice_id,reason,raised_by,disputed_amount,status)
     VALUES($1,$2,$3,'K124b raced dispute',$4,100,'open')`,
    [raced, company, invoice, user]);
  await pool.query(
    `INSERT INTO customer_invoices(id,company_id,invoice_number,customer_id,client_id,invoice_date,due_date,subtotal,tax_amount,total_amount,status,created_by)
     VALUES($1,$2,'K124B-INV-CENT',$3,$3,'2026-01-01','2026-01-31',1000,150,1150,'approved',$4)`,
    [centInvoice, company, customer, user]);
  await pool.query(
    `INSERT INTO customer_invoice_disputes(id,company_id,customer_invoice_id,reason,raised_by,disputed_amount,status)
     VALUES($1,$2,$3,'K124b cent dispute',$4,10,'open')`,
    [cent, company, centInvoice, user]);
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM customer_invoice_disputes WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM credit_notes WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM customer_invoices WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM customers WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=$1', [company]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

it('lets only one of two concurrent resolves create a credit note', async () => {
  const both = await Promise.allSettled([
    resolveDispute(company, raced, user, { mode: 'resolve_with_credit', creditDate: '2026-02-01' }),
    resolveDispute(company, raced, user, { mode: 'resolve_with_credit', creditDate: '2026-02-01' }),
  ]);

  expect(both.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  const rejected = both.find(r => r.status === 'rejected') as PromiseRejectedResult;
  expect(String(rejected.reason)).toMatch(/is not open/);

  // The outcome that matters: one disputed amount, one financial document.
  const { rows } = await pool.query(
    `SELECT id, total_amount FROM credit_notes
      WHERE company_id=$1 AND customer_invoice_id=$2 AND reason LIKE '%raced%'`,
    [company, invoice]);
  expect(rows).toHaveLength(1);

  // …and the dispute points at the one that exists, not an orphan.
  const { rows: d } = await pool.query(
    'SELECT status, credit_note_id FROM customer_invoice_disputes WHERE id=$1', [raced]);
  expect(d[0].status).toBe('resolved');
  expect(d[0].credit_note_id).toBe(rows[0].id);
});

it('refuses to resolve a dispute that is no longer open, without creating a document', async () => {
  const before = await pool.query('SELECT count(*)::int AS n FROM credit_notes WHERE company_id=$1', [company]);
  await expect(
    resolveDispute(company, raced, user, { mode: 'resolve_with_credit', creditDate: '2026-02-01' }),
  ).rejects.toThrow(/is not open/);
  const after = await pool.query('SELECT count(*)::int AS n FROM credit_notes WHERE company_id=$1', [company]);
  expect(after.rows[0].n).toBe(before.rows[0].n);
});

it('reports a dispute from another tenant as not found and writes nothing', async () => {
  const other = crypto.randomUUID();
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [other, 'K124b other tenant']);
  try {
    await expect(
      resolveDispute(other, cent, user, { mode: 'resolve_no_credit' }),
    ).rejects.toThrow(/not found/);
    const { rows } = await pool.query(
      'SELECT status FROM customer_invoice_disputes WHERE id=$1', [cent]);
    expect(rows[0].status).toBe('open');
  } finally {
    await pool.query('DELETE FROM companies WHERE id=$1', [other]);
  }
});

it('splits a gross of 10.00 at 15% so subtotal + VAT is exactly the disputed amount', async () => {
  const resolved = await resolveDispute(company, cent, user, {
    mode: 'resolve_with_credit', creditDate: '2026-02-01',
  });
  const { rows } = await pool.query(
    'SELECT subtotal, tax_rate, tax_amount, total_amount FROM credit_notes WHERE id=$1',
    [resolved.creditNoteId]);
  const r = rows[0];
  expect(Number(r.tax_rate)).toBeCloseTo(15, 2);
  expect(Number(r.subtotal)).toBeCloseTo(8.70, 2);
  // 8.70 * 15% rounds to 1.31 and would total 10.01; the remainder is 1.30.
  expect(Number(r.tax_amount)).toBeCloseTo(1.30, 2);
  expect(Number(r.total_amount)).toBeCloseTo(10, 2);
  expect(Number(r.subtotal) + Number(r.tax_amount)).toBeCloseTo(10, 2);
});
