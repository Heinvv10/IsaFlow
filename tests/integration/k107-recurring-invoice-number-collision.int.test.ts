// RED regression: K-107 — the recurring invoice number is RINV-<slug>-<YYYYMM>,
// constant for the whole calendar month, so a daily/weekly template collides on
// its second run in the same month.
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { executeRecurring } from '../../src/modules/accounting/services/core/recurringTransactionService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID();
const user = crypto.randomUUID();
const customer = crypto.randomUUID();
const supplier = crypto.randomUUID();
const arTemplate = crypto.randomUUID();
const apTemplate = crypto.randomUUID();

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'K107 fixture']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')", [company, user]);
  await pool.query('INSERT INTO customers(id,company_id,name) VALUES($1,$2,$3)', [customer, company, 'Daily Retainer Client']);
  await pool.query('INSERT INTO suppliers(id,company_id,name) VALUES($1,$2,$3)', [supplier, company, 'Daily Supplier']);
  await pool.query(
    `INSERT INTO recurring_transaction_templates(id,company_id,name,entity_type,template_data,frequency,created_by)
     VALUES($1,$2,'Daily retainer','customer_invoice',$3,'daily',$4)`,
    [arTemplate, company, JSON.stringify({ clientId: customer, subtotal: 100, vatAmount: 15, totalAmount: 115 }), user],
  );
  await pool.query(
    `INSERT INTO recurring_transaction_templates(id,company_id,name,entity_type,template_data,frequency,created_by)
     VALUES($1,$2,'Daily supply','supplier_invoice',$3,'daily',$4)`,
    [apTemplate, company, JSON.stringify({ supplierId: supplier, subtotal: 100, vatAmount: 15, totalAmount: 115 }), user],
  );
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM recurring_transaction_templates WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM supplier_invoices WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM customer_invoices WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM suppliers WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM customers WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM company_users WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=$1', [company]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

it('a daily customer template runs twice in one month without a number collision', async () => {
  await executeRecurring(company, arTemplate, user);
  const second = await executeRecurring(company, arTemplate, user).then(
    () => 'ok' as const,
    (err: unknown) => (err as { code?: string }).code ?? String(err),
  );
  const numbers = await pool.query(
    'SELECT invoice_number FROM customer_invoices WHERE company_id=$1 ORDER BY invoice_number', [company]);
  // RED: today the second run raises 23505 on uq_customer_invoices_company_number.
  expect({ second, distinct: new Set(numbers.rows.map(r => r.invoice_number)).size })
    .toEqual({ second: 'ok', distinct: 2 });
});

it('a daily supplier template runs twice in one month without duplicating the bill number', async () => {
  await executeRecurring(company, apTemplate, user);
  await executeRecurring(company, apTemplate, user);
  const rows = await pool.query(
    'SELECT invoice_number, duplicate_fingerprint FROM supplier_invoices WHERE company_id=$1', [company]);
  // RED: today both bills carry the identical number and fingerprint.
  expect({
    rows: rows.rows.length,
    distinctNumbers: new Set(rows.rows.map(r => r.invoice_number)).size,
  }).toEqual({ rows: 2, distinctNumbers: 2 });
});
