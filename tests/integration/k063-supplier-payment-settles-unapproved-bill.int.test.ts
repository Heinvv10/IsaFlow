/**
 * K-063 — a processed supplier payment settles a bill that never credited AP.
 *
 * supplierAllocationLines.ts:29 blocks only 'cancelled' and 'draft'.
 * supplier_invoices_status_check also allows 'pending_approval', and AP is
 * credited only by approveSupplierInvoice (supplierInvoiceWorkflowService.ts:173
 * postJournalEntry), so a pending_approval bill has no journal at all. The
 * allocation still moves amount_paid, and recomputeInvoiceStatus leaves the
 * status alone because 'pending_approval' is outside BALANCE_DERIVED
 * (invoiceStatusRecompute.ts:74) — the bill reads unapproved and paid at once,
 * while the payment's DR Accounts Payable has no matching credit.
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
const company = crypto.randomUUID(), user = crypto.randomUUID(), supplier = crypto.randomUUID();
const bill = crypto.randomUUID(), payment = crypto.randomUUID();

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'K063 AP fixture']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await pool.query('INSERT INTO suppliers(id,company_id,name) VALUES($1,$2,$3)', [supplier, company, 'K063 supplier']);
  // Never approved: no gl_journal_entry_id, so AP was never credited for it.
  await pool.query(
    `INSERT INTO supplier_invoices(id,company_id,supplier_id,invoice_number,invoice_date,due_date,
       subtotal,tax_amount,total_amount,amount_paid,status,created_by)
     VALUES($1,$2,$3,'K063-BILL-1',CURRENT_DATE - 5,CURRENT_DATE + 25,1000,0,1000,0,'pending_approval',$4)`,
    [bill, company, supplier, user],
  );
  await pool.query(
    `INSERT INTO supplier_payments(id,company_id,supplier_id,payment_number,payment_date,total_amount,
       payment_method,status,created_by)
     VALUES($1,$2,$3,'K063-PAY-1',CURRENT_DATE,1000,'eft','processed',$4)`,
    [payment, company, supplier, user],
  );
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM payment_allocations WHERE payment_id=$1', [payment]);
    await pool.query('DELETE FROM supplier_payments WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM supplier_invoices WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM suppliers WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=$1', [company]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

it('refuses to apply a payment to a bill that has not been approved', async () => {
  // withAuth supplies the request transaction the payment row lock requires.
  const client: PoolClient = await getPoolForTests().connect();
  let error: unknown = null;
  try {
    await client.query('BEGIN');
    await als.run({ client, userId: user, companyId: company, claims: { sub: user } }, async () => {
      try {
        const plan = await planSupplierPaymentApplication(company, payment, [{ invoiceId: bill, amount: 1000 }]);
        await applySupplierPaymentPlan(company, plan, user);
      } catch (err) { error = err; }
    });
    await client.query('COMMIT');
  } finally {
    client.release();
  }

  const { rows } = await pool.query('SELECT amount_paid, status, gl_journal_entry_id FROM supplier_invoices WHERE id=$1', [bill]);
  expect(rows[0].gl_journal_entry_id).toBeNull();
  expect(Number(rows[0].amount_paid)).toBe(0);
  expect(rows[0].status).toBe('pending_approval');
  expect(String(error)).toMatch(/pending_approval/);
});
