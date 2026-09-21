/**
 * K-125 — debtors queries drop invoices whose amount_paid is NULL.
 *
 * customer_invoices.amount_paid is NULLABLE (default 0). debtorsManagerService
 * computes `ci.total_amount - ci.amount_paid` with no COALESCE at :90, :118,
 * :155 and :253, so a NULL propagates, the `> 0` predicate is NULL rather than
 * true, and the invoice disappears from every debtors view and from the
 * collection stats.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import {
  getCollectionStats,
  getDebtorDetail,
  getDebtorsSummary,
  getOverdueInvoices,
} from '../../src/modules/accounting/services/ar/debtorsManagerService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID(), user = crypto.randomUUID(), customer = crypto.randomUUID();
const invoice = crypto.randomUUID();

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'K125 fixture']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await pool.query('INSERT INTO customers(id,company_id,name) VALUES($1,$2,$3)', [customer, company, 'K125 customer']);
  await pool.query(
    `INSERT INTO customer_invoices(id,company_id,invoice_number,customer_id,client_id,invoice_date,due_date,subtotal,tax_amount,total_amount,amount_paid,status,created_by)
     VALUES($1,$2,'K125-INV-1',$3,$3,'2026-01-01','2026-01-31',1000,150,1150,NULL,'approved',$4)`,
    [invoice, company, customer, user]);
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM customer_invoices WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM customers WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=$1', [company]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

it('an unpaid invoice with NULL amount_paid still owes its full total', async () => {
  const summary = await getDebtorsSummary(company);
  expect.soft(summary).toHaveLength(1);
  expect.soft(summary[0]?.totalOutstanding).toBe(1150);

  const detail = await getDebtorDetail(company, customer);
  expect.soft(detail).toHaveLength(1);

  const stats = await getCollectionStats(company);
  expect.soft(stats.totalOutstanding).toBe(1150);
});

it('lists the NULL-paid invoice among the overdue ones', async () => {
  const overdue = await getOverdueInvoices(company);
  expect(overdue).toHaveLength(1);
  expect(overdue[0]!.outstanding).toBe(1150);
  expect(overdue[0]!.amountPaid).toBe(0);
});

it('reports a zero collection rate when every amount_paid is NULL', async () => {
  const stats = await getCollectionStats(company);
  expect(stats.collectionRate).toBe(0);
});

it('a partly paid invoice still nets off correctly', async () => {
  const partial = crypto.randomUUID();
  await pool.query(
    `INSERT INTO customer_invoices(id,company_id,invoice_number,customer_id,client_id,invoice_date,due_date,subtotal,tax_amount,total_amount,amount_paid,status,created_by)
     VALUES($1,$2,'K125-INV-2',$3,$3,'2026-01-01','2026-01-31',1000,150,1150,400,'partially_paid',$4)`,
    [partial, company, customer, user]);
  try {
    const summary = await getDebtorsSummary(company);
    expect(summary).toHaveLength(1);
    expect(summary[0]!.totalOutstanding).toBe(1150 + 750);
  } finally {
    await pool.query('DELETE FROM customer_invoices WHERE id=$1', [partial]);
  }
});

it('drops a fully paid invoice whose amount_paid equals the total', async () => {
  const settled = crypto.randomUUID();
  await pool.query(
    `INSERT INTO customer_invoices(id,company_id,invoice_number,customer_id,client_id,invoice_date,due_date,subtotal,tax_amount,total_amount,amount_paid,status,created_by)
     VALUES($1,$2,'K125-INV-3',$3,$3,'2026-01-01','2026-01-31',1000,150,1150,1150,'approved',$4)`,
    [settled, company, customer, user]);
  try {
    const detail = await getDebtorDetail(company, customer);
    expect(detail.map((d) => d.invoiceNumber)).toEqual(['K125-INV-1']);
  } finally {
    await pool.query('DELETE FROM customer_invoices WHERE id=$1', [settled]);
  }
});

it('does not surface the invoice for another tenant', async () => {
  const other = crypto.randomUUID();
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [other, 'K125 other tenant']);
  try {
    expect(await getDebtorsSummary(other)).toHaveLength(0);
    expect((await getCollectionStats(other)).totalOutstanding).toBe(0);
  } finally {
    await pool.query('DELETE FROM companies WHERE id=$1', [other]);
  }
});
