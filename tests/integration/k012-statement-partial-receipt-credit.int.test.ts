/**
 * K-012 — an emailed statement credits only the allocated part of a receipt.
 *
 * statementEmailService.ts:130 uses COALESCE(SUM(cpa.amount_allocated),
 * cp.total_amount). The COALESCE only fires when a receipt has NO allocation
 * rows at all, so a partially allocated receipt is credited at its allocated
 * amount and the unapplied remainder disappears from the document the customer
 * receives — overstating what they owe.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { fetchStatementData } from '../../src/modules/accounting/services/ar/statementEmailService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID(), user = crypto.randomUUID(), customer = crypto.randomUUID();
const invoice = crypto.randomUUID(), receipt = crypto.randomUUID();

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'K012 statement fixture']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await pool.query('INSERT INTO customers(id,company_id,name,email) VALUES($1,$2,$3,$4)', [customer, company, 'K012 customer', 'k012@test.local']);
  await pool.query(`INSERT INTO customer_invoices(id,company_id,invoice_number,customer_id,client_id,subtotal,total_amount,amount_paid,status,created_by,invoice_date)
    VALUES($1,$2,'K012-INV-1',$3,$3,100,100,40,'sent',$4,'2026-03-01')`, [invoice, company, customer, user]);
  // R100 received, only R40 allocated to the invoice: R60 sits as unallocated credit.
  await pool.query(`INSERT INTO customer_payments(id,company_id,client_id,payment_number,payment_date,total_amount,status,created_by)
    VALUES($1,$2,$3,'K012-RCT-1','2026-03-05',100,'confirmed',$4)`, [receipt, company, customer, user]);
  await pool.query('INSERT INTO customer_payment_allocations(payment_id,invoice_id,amount_allocated) VALUES($1,$2,40)', [receipt, invoice]);
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM customer_payment_allocations WHERE payment_id=$1', [receipt]);
    await pool.query('DELETE FROM customer_payments WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM customer_invoices WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM customers WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=$1', [company]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

it('credits the whole confirmed receipt, not just its allocated part', async () => {
  const statement = await fetchStatementData(company, customer, '2026-03-31');
  expect(statement).not.toBeNull();
  const payment = statement!.transactions.find(t => t.type === 'payment');
  expect(payment?.credit).toBe(100);
  expect(statement!.summary.totalPaid).toBe(100);
  expect(statement!.summary.balance).toBe(0);
  expect(statement!.excluded).toEqual([]);
});
