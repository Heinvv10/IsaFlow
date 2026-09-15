/**
 * K-124 — dispute resolution ignores the legacy customer_id column.
 *
 * customer_invoices carries BOTH client_id (nullable) and customer_id (NOT NULL);
 * CLAUDE.md requires COALESCE(ci.client_id, ci.customer_id). resolveDispute
 * (disputeService.ts:290-300) reads bare client_id, and the listDisputes joins
 * (:199,:211,:222,:233) join customers on ci.client_id only. On an invoice whose
 * client_id is NULL the dispute can never be resolved with credit, and it lists
 * with a blank customer name.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { listDisputes, resolveDispute } from '../../src/modules/accounting/services/ar/disputeService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID(), user = crypto.randomUUID(), customer = crypto.randomUUID();
const invoice = crypto.randomUUID(), dispute = crypto.randomUUID();

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'K124 fixture']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await pool.query('INSERT INTO customers(id,company_id,name) VALUES($1,$2,$3)', [customer, company, 'K124 legacy customer']);
  // A migrated invoice: customer_id set, client_id NULL.
  await pool.query(
    `INSERT INTO customer_invoices(id,company_id,invoice_number,customer_id,client_id,invoice_date,due_date,subtotal,tax_amount,total_amount,status,created_by)
     VALUES($1,$2,'K124-INV-1',$3,NULL,'2026-01-01','2026-01-31',1000,150,1150,'approved',$4)`,
    [invoice, company, customer, user]);
  await pool.query(
    `INSERT INTO customer_invoice_disputes(id,company_id,customer_invoice_id,reason,raised_by,disputed_amount,status)
     VALUES($1,$2,$3,'K124 pricing dispute',$4,100,'open')`,
    [dispute, company, invoice, user]);
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

it('lists the legacy-linked dispute with its customer name', async () => {
  const { disputes } = await listDisputes(company, {});
  expect(disputes).toHaveLength(1);
  expect(disputes[0]!.clientName).toBe('K124 legacy customer');
});

it('resolves a legacy-linked dispute with a credit note', async () => {
  const resolved = await resolveDispute(company, dispute, user, {
    mode: 'resolve_with_credit',
    creditDate: '2026-02-01',
    resolutionNote: 'K124',
  });
  expect(resolved.creditNoteId).not.toBeNull();
});

it('still prefers client_id when both columns are populated', async () => {
  const modern = crypto.randomUUID(), modernCustomer = crypto.randomUUID();
  const modernDispute = crypto.randomUUID();
  await pool.query('INSERT INTO customers(id,company_id,name) VALUES($1,$2,$3)',
    [modernCustomer, company, 'K124 modern client']);
  await pool.query(
    `INSERT INTO customer_invoices(id,company_id,invoice_number,customer_id,client_id,invoice_date,due_date,subtotal,tax_amount,total_amount,status,created_by)
     VALUES($1,$2,'K124-INV-2',$3,$4,'2026-01-01','2026-01-31',1000,150,1150,'approved',$5)`,
    [modern, company, customer, modernCustomer, user]);
  await pool.query(
    `INSERT INTO customer_invoice_disputes(id,company_id,customer_invoice_id,reason,raised_by,disputed_amount,status)
     VALUES($1,$2,$3,'K124 modern dispute',$4,50,'open')`,
    [modernDispute, company, modern, user]);

  const { disputes } = await listDisputes(company, { customerInvoiceId: modern });
  expect(disputes).toHaveLength(1);
  expect(disputes[0]!.clientName).toBe('K124 modern client');

  const resolved = await resolveDispute(company, modernDispute, user, {
    mode: 'resolve_with_credit',
    creditDate: '2026-02-01',
    resolutionNote: 'K124 modern',
  });
  const { rows } = await pool.query('SELECT client_id FROM credit_notes WHERE id=$1',
    [resolved.creditNoteId]);
  expect(rows[0].client_id).toBe(modernCustomer);
});

it('books the credit note against the legacy customer for the disputed amount', async () => {
  const { rows } = await pool.query(
    `SELECT cn.client_id, cn.total_amount, cn.customer_invoice_id
     FROM credit_notes cn WHERE cn.company_id=$1 AND cn.customer_invoice_id=$2`,
    [company, invoice]);
  expect(rows).toHaveLength(1);
  expect(rows[0].client_id).toBe(customer);
  expect(Number(rows[0].total_amount)).toBe(100);
});

it('splits the disputed amount at the invoice VAT rate instead of booking it all to revenue', async () => {
  // disputed_amount is a slice of the VAT-INCLUSIVE total (invoice 1000 + 150
  // VAT). taxRate 0 would credit all 100 to revenue and nothing to VAT output.
  const { rows } = await pool.query(
    `SELECT cn.subtotal, cn.tax_rate, cn.tax_amount, cn.total_amount
     FROM credit_notes cn WHERE cn.company_id=$1 AND cn.customer_invoice_id=$2`,
    [company, invoice]);
  expect(rows).toHaveLength(1);
  expect(Number(rows[0].tax_rate)).toBeCloseTo(15, 2);
  expect(Number(rows[0].subtotal)).toBeCloseTo(86.96, 2);
  expect(Number(rows[0].tax_amount)).toBeCloseTo(13.04, 2);
  expect(Number(rows[0].subtotal) + Number(rows[0].tax_amount))
    .toBeCloseTo(Number(rows[0].total_amount), 2);
});

it('does not list the legacy dispute for another tenant', async () => {
  const other = crypto.randomUUID();
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [other, 'K124 other tenant']);
  try {
    const page = await listDisputes(other, {});
    expect(page.disputes).toHaveLength(0);
  } finally {
    await pool.query('DELETE FROM companies WHERE id=$1', [other]);
  }
});
