/**
 * K-123 — listDisputes returns the page size, not the matching row count.
 *
 * disputeService.ts:246 returns `total: disputes.length`, which is the length
 * of the LIMIT-ed page. No COUNT(*) is issued, so any pager driven by `total`
 * stops at page one and every later dispute is invisible.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { listDisputes } from '../../src/modules/accounting/services/ar/disputeService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID(), user = crypto.randomUUID(), customer = crypto.randomUUID();
const invoiceIds = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'K123 fixture']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await pool.query('INSERT INTO customers(id,company_id,name) VALUES($1,$2,$3)', [customer, company, 'K123 customer']);
  for (let i = 0; i < invoiceIds.length; i++) {
    await pool.query(
      `INSERT INTO customer_invoices(id,company_id,invoice_number,customer_id,client_id,invoice_date,due_date,subtotal,tax_amount,total_amount,status,created_by)
       VALUES($1,$2,$3,$4,$4,'2026-01-01','2026-01-31',1000,150,1150,'approved',$5)`,
      [invoiceIds[i], company, `K123-INV-${i}`, customer, user]);
    await pool.query(
      `INSERT INTO customer_invoice_disputes(id,company_id,customer_invoice_id,reason,raised_by,disputed_amount,status)
       VALUES($1,$2,$3,$4,$5,100,'open')`,
      [crypto.randomUUID(), company, invoiceIds[i], `K123 dispute ${i}`, user]);
  }
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM customer_invoice_disputes WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM customer_invoices WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM customers WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=$1', [company]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

it('reports every matching dispute in total, not just the page returned', async () => {
  const page = await listDisputes(company, { limit: 2, offset: 0 });
  expect(page.disputes).toHaveLength(2);
  expect(page.total).toBe(3);
});

it('counts only the disputes matching the status filter', async () => {
  await pool.query(
    "UPDATE customer_invoice_disputes SET status='rejected' WHERE customer_invoice_id=$1",
    [invoiceIds[2]]);
  try {
    const open = await listDisputes(company, { status: 'open', limit: 1 });
    expect(open.disputes).toHaveLength(1);
    expect(open.total).toBe(2);
  } finally {
    await pool.query(
      "UPDATE customer_invoice_disputes SET status='open' WHERE customer_invoice_id=$1",
      [invoiceIds[2]]);
  }
});

it('reports the same total on a page past the end', async () => {
  const page = await listDisputes(company, { limit: 2, offset: 4 });
  expect(page.disputes).toHaveLength(0);
  expect(page.total).toBe(3);
});

it('counts a single-invoice filter without leaking the other invoices', async () => {
  const page = await listDisputes(company, { customerInvoiceId: invoiceIds[0]! });
  expect(page.total).toBe(1);
  expect(page.disputes).toHaveLength(1);
});

it('does not count another tenant’s disputes', async () => {
  const other = crypto.randomUUID();
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [other, 'K123 other tenant']);
  try {
    const page = await listDisputes(other, {});
    expect(page.total).toBe(0);
    expect(page.disputes).toHaveLength(0);
  } finally {
    await pool.query('DELETE FROM companies WHERE id=$1', [other]);
  }
});
