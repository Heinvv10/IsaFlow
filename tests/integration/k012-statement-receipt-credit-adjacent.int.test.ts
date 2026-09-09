/**
 * K-012 adjacent cases — the statement credits a receipt at what the customer
 * paid, regardless of how much of it has been matched to invoices, and still
 * respects tenant, status and as-at-date boundaries.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { fetchStatementData } from '../../src/modules/accounting/services/ar/statementEmailService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID(), other = crypto.randomUUID(), user = crypto.randomUUID();
const customer = crypto.randomUUID();
const invoice = crypto.randomUUID();
const unallocated = crypto.randomUUID(), full = crypto.randomUUID();
const foreign = crypto.randomUUID(), draft = crypto.randomUUID(), late = crypto.randomUUID();
const cancelled = crypto.randomUUID();

async function receipt(id: string, co: string, cust: string, num: string, amount: number, status: string, date: string) {
  await pool.query(`INSERT INTO customer_payments(id,company_id,client_id,payment_number,payment_date,total_amount,status,created_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [id, co, cust, num, date, amount, status, user]);
}

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2),($3,$4)', [company, 'K012 adjacent', other, 'K012 other tenant']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await pool.query('INSERT INTO customers(id,company_id,name,email) VALUES($1,$2,$3,$4)',
    [customer, company, 'K012 customer', 'k012a@test.local']);
  await pool.query(`INSERT INTO customer_invoices(id,company_id,invoice_number,customer_id,client_id,subtotal,total_amount,amount_paid,status,created_by,invoice_date)
    VALUES($1,$2,'K012A-INV-1',$3,$3,70,70,70,'sent',$4,'2026-03-01')`, [invoice, company, customer, user]);

  await receipt(unallocated, company, customer, 'K012-RCT-2', 250, 'confirmed', '2026-03-05');
  await receipt(full, company, customer, 'K012-RCT-3', 70, 'reconciled', '2026-03-06');
  await pool.query('INSERT INTO customer_payment_allocations(payment_id,invoice_id,amount_allocated) VALUES($1,$2,70)', [full, invoice]);
  // Deliberately the SAME client_id under a different company_id: only the
  // company_id predicate keeps this receipt off our customer's statement.
  await receipt(foreign, other, customer, 'K012-RCT-OTHER', 900, 'confirmed', '2026-03-07');
  await receipt(draft, company, customer, 'K012-RCT-DRAFT', 500, 'draft', '2026-03-08');
  await receipt(late, company, customer, 'K012-RCT-LATE', 999, 'confirmed', '2026-04-01');
  await receipt(cancelled, company, customer, 'K012-RCT-CANCELLED', 800, 'cancelled', '2026-03-09');
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM customer_payment_allocations WHERE payment_id = ANY($1::uuid[])', [[full]]);
    await pool.query('DELETE FROM customer_payments WHERE company_id = ANY($1::uuid[])', [[company, other]]);
    await pool.query('DELETE FROM customer_invoices WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM customers WHERE company_id = ANY($1::uuid[])', [[company, other]]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1::uuid[])', [[company, other]]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

it('credits an unallocated receipt at its full amount', async () => {
  const s = await fetchStatementData(company, customer, '2026-03-31');
  expect(s!.transactions.find(t => t.reference === 'K012-RCT-2')?.credit).toBe(250);
});

it('credits a fully allocated receipt at its full amount, exactly once', async () => {
  const s = await fetchStatementData(company, customer, '2026-03-31');
  const rows = s!.transactions.filter(t => t.reference === 'K012-RCT-3');
  expect(rows).toHaveLength(1);
  expect(rows[0]!.credit).toBe(70);
});

it('never shows a receipt belonging to another company', async () => {
  const s = await fetchStatementData(company, customer, '2026-03-31');
  const refs = [
    ...s!.transactions.map(t => t.reference),
    ...s!.excluded.map(e => e.documentNumber ?? ''),
  ];
  expect(refs).not.toContain('K012-RCT-OTHER');
});

it('names an unconfirmed receipt as excluded at the amount received', async () => {
  const s = await fetchStatementData(company, customer, '2026-03-31');
  const ex = s!.excluded.find(e => e.documentNumber === 'K012-RCT-DRAFT');
  expect(ex?.reason).toBe('payment_not_confirmed');
  expect(ex?.amount).toBe(500);
});

it('names a cancelled receipt as excluded at the amount received, crediting nothing', async () => {
  const s = await fetchStatementData(company, customer, '2026-03-31');
  expect(s!.transactions.map(t => t.reference)).not.toContain('K012-RCT-CANCELLED');
  const ex = s!.excluded.find(e => e.documentNumber === 'K012-RCT-CANCELLED');
  expect(ex?.reason).toBe('payment_not_confirmed');
  expect(ex?.amount).toBe(800);
});

it('leaves out a receipt dated after the as-at date, and totals the rest', async () => {
  const s = await fetchStatementData(company, customer, '2026-03-31');
  expect(s!.transactions.map(t => t.reference)).not.toContain('K012-RCT-LATE');
  // R70 invoiced, R250 + R70 received: the account is R250 in credit.
  expect(s!.summary.totalInvoiced).toBe(70);
  expect(s!.summary.totalPaid).toBe(320);
  expect(s!.summary.balance).toBe(-250);
});
