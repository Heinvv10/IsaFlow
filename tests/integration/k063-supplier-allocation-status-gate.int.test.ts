/**
 * K-063 adjacent cases for the inverted status gate in
 * `supplierAllocationLines#assertBillAllocatable`.
 *
 * The defect was a DENY-list ('cancelled', 'draft') that let the other two
 * statuses `supplier_invoices_status_check` permits through. 'pending_approval'
 * is covered by k063-supplier-payment-settles-unapproved-bill; this file covers
 * the second hole ('disputed'), the foreign-tenant read, and the happy path
 * that must still work — a bill whose settlement agrees with the payment.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { als } from '../../src/lib/als';
import { getPoolForTests } from '../../src/lib/neon';
import {
  planSupplierPaymentApplication,
  applySupplierPaymentPlan,
} from '../../src/modules/accounting/services/ap/supplierPaymentApplicationService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID(), other = crypto.randomUUID();
const user = crypto.randomUUID(), supplier = crypto.randomUUID(), otherSupplier = crypto.randomUUID();
const disputed = crypto.randomUUID(), approved = crypto.randomUUID(), foreign = crypto.randomUUID();
const payDisputed = crypto.randomUUID(), payApproved = crypto.randomUUID(), payForeign = crypto.randomUUID();

async function bill(id: string, comp: string, supp: string, number: string, status: string) {
  await pool.query(
    `INSERT INTO supplier_invoices(id,company_id,supplier_id,invoice_number,invoice_date,due_date,
       subtotal,tax_amount,total_amount,amount_paid,status,created_by)
     VALUES($1,$2,$3,$4,CURRENT_DATE - 5,CURRENT_DATE + 25,1000,0,1000,0,$5,$6)`,
    [id, comp, supp, number, status, user],
  );
}

async function payment(id: string, comp: string, supp: string, number: string) {
  await pool.query(
    `INSERT INTO supplier_payments(id,company_id,supplier_id,payment_number,payment_date,total_amount,
       payment_method,status,created_by)
     VALUES($1,$2,$3,$4,CURRENT_DATE,1000,'eft','processed',$5)`,
    [id, comp, supp, number, user],
  );
}

/** Run a plan+apply the way `withAuth` does: inside one request transaction. */
async function attempt(paymentId: string, invoiceId: string, amount: number): Promise<unknown> {
  const client: PoolClient = await getPoolForTests().connect();
  let error: unknown = null;
  try {
    await client.query('BEGIN');
    await als.run({ client, userId: user, companyId: company, claims: { sub: user } }, async () => {
      try {
        const plan = await planSupplierPaymentApplication(company, paymentId, [{ invoiceId, amount }]);
        await applySupplierPaymentPlan(company, plan, user);
      } catch (err) { error = err; }
    });
    await client.query('COMMIT');
  } finally {
    client.release();
  }
  return error;
}

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2),($3,$4)',
    [company, 'K063 gate', other, 'K063 gate other']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await pool.query('INSERT INTO suppliers(id,company_id,name) VALUES($1,$2,$3),($4,$5,$6)',
    [supplier, company, 'K063 supplier', otherSupplier, other, 'K063 other supplier']);
  await bill(disputed, company, supplier, 'K063G-DISPUTED', 'disputed');
  await bill(approved, company, supplier, 'K063G-APPROVED', 'approved');
  await bill(foreign, other, otherSupplier, 'K063G-FOREIGN', 'approved');
  await payment(payDisputed, company, supplier, 'K063G-PAY-1');
  await payment(payApproved, company, supplier, 'K063G-PAY-2');
  await payment(payForeign, company, supplier, 'K063G-PAY-3');
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

it('refuses a disputed bill — the second status the deny-list let through', async () => {
  const error = await attempt(payDisputed, disputed, 1000);
  expect(String(error)).toMatch(/disputed and cannot receive a payment/);

  const { rows } = await pool.query('SELECT amount_paid, status FROM supplier_invoices WHERE id=$1', [disputed]);
  expect(Number(rows[0].amount_paid)).toBe(0);
  expect(rows[0].status).toBe('disputed');
});

it("refuses another tenant's bill without disclosing that it exists", async () => {
  const error = await attempt(payForeign, foreign, 1000);
  expect(String(error)).toMatch(/not found/);

  const { rows } = await pool.query('SELECT amount_paid FROM supplier_invoices WHERE id=$1', [foreign]);
  expect(Number(rows[0].amount_paid)).toBe(0);
});

it('still settles an approved bill, with subledger and payment in agreement', async () => {
  const error = await attempt(payApproved, approved, 1000);
  expect(error).toBeNull();

  const { rows: billRows } = await pool.query(
    'SELECT amount_paid, balance, status FROM supplier_invoices WHERE id=$1', [approved]);
  expect(Number(billRows[0].amount_paid)).toBe(1000);
  expect(Number(billRows[0].balance)).toBe(0);
  expect(billRows[0].status).toBe('paid');

  // The allocation rows must account for the whole payment, and the payment
  // must read fully applied — the split that K-063's sibling defects created.
  const { rows: sumRows } = await pool.query(
    `SELECT COALESCE(SUM(pa.amount_allocated),0)::numeric AS allocated, sp.total_amount, sp.status
     FROM supplier_payments sp LEFT JOIN payment_allocations pa ON pa.payment_id = sp.id
     WHERE sp.id=$1 GROUP BY sp.total_amount, sp.status`, [payApproved]);
  expect(Number(sumRows[0].allocated)).toBe(Number(sumRows[0].total_amount));
  expect(sumRows[0].status).toBe('reconciled');
});
