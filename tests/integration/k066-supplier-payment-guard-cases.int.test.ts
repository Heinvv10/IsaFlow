/**
 * K-066 adjacent cases for `createSupplierPayment`'s new bill checks.
 *
 * The RED test covers a foreign supplier and the two statuses the old
 * deny-list happened to name. These are the cases neither file reaches: a bill
 * in ANOTHER TENANT (which must stay indistinguishable from one that does not
 * exist), a `pending_approval` bill (the status that has no AP credit at all),
 * and the happy path, where the payment's allocations must account for exactly
 * the payment total.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { createSupplierPayment } from '../../src/modules/accounting/services/ap/supplierPaymentService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID(), other = crypto.randomUUID(), user = crypto.randomUUID();
const supplier = crypto.randomUUID(), otherSupplier = crypto.randomUUID();
const pending = crypto.randomUUID(), approved = crypto.randomUUID(), foreign = crypto.randomUUID();

async function bill(id: string, comp: string, supp: string, number: string, status: string) {
  await pool.query(
    `INSERT INTO supplier_invoices(id,company_id,supplier_id,invoice_number,invoice_date,due_date,
       subtotal,tax_amount,total_amount,amount_paid,status,created_by)
     VALUES($1,$2,$3,$4,CURRENT_DATE - 5,CURRENT_DATE + 25,500,0,500,0,$5,$6)`,
    [id, comp, supp, number, status, user],
  );
}

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2),($3,$4)',
    [company, 'K066G company', other, 'K066G other']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await pool.query('INSERT INTO suppliers(id,company_id,name) VALUES($1,$2,$3),($4,$5,$6)',
    [supplier, company, 'K066G supplier', otherSupplier, other, 'K066G other supplier']);
  await bill(pending, company, supplier, 'K066G-PENDING', 'pending_approval');
  await bill(approved, company, supplier, 'K066G-APPROVED', 'approved');
  await bill(foreign, other, otherSupplier, 'K066G-FOREIGN', 'approved');
});

afterAll(async () => {
  const companies = [company, other];
  try {
    await pool.query('DELETE FROM payment_allocations WHERE payment_id IN (SELECT id FROM supplier_payments WHERE company_id = ANY($1))', [companies]);
    await pool.query('DELETE FROM supplier_payments WHERE company_id = ANY($1)', [companies]);
    await pool.query('DELETE FROM supplier_invoices WHERE company_id = ANY($1)', [companies]);
    await pool.query('DELETE FROM suppliers WHERE company_id = ANY($1)', [companies]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1)', [companies]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

function payment(invoiceId: string) {
  return createSupplierPayment(company, {
    supplierId: supplier,
    paymentDate: '2026-06-30',
    totalAmount: 500,
    allocations: [{ invoiceId, amount: 500 }],
  }, user);
}

it('refuses a bill that has not been approved, so AP was never credited', async () => {
  await expect(payment(pending)).rejects.toThrow(/pending_approval and cannot receive a payment/);
  const { rows } = await pool.query('SELECT amount_paid FROM supplier_invoices WHERE id=$1', [pending]);
  expect(Number(rows[0].amount_paid)).toBe(0);
});

it("refuses another tenant's bill as simply not found", async () => {
  await expect(payment(foreign)).rejects.toThrow(/not found or belong to a different company/);
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM payment_allocations WHERE invoice_id=$1', [foreign]);
  expect(rows[0].n).toBe(0);
});

it("still creates a payment whose allocations account for the whole payment", async () => {
  const created = await payment(approved);
  const { rows } = await pool.query(
    `SELECT sp.total_amount, COALESCE(SUM(pa.amount_allocated),0)::numeric AS allocated
     FROM supplier_payments sp LEFT JOIN payment_allocations pa ON pa.payment_id = sp.id
     WHERE sp.id=$1 AND sp.company_id=$2 GROUP BY sp.total_amount`, [created.id, company]);
  expect(Number(rows[0].allocated)).toBe(Number(rows[0].total_amount));
  expect(Number(rows[0].allocated)).toBe(500);
});
