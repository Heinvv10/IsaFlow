/**
 * K-064 — creating a supplier payment batch validates nothing.
 *
 * batchPaymentService.ts:78-98 loops the requested allocations and INSERTs
 * payment_allocations rows straight from the request body. No statement reads
 * supplier_invoices, so the bill is never checked for tenant, supplier,
 * status or outstanding balance. payment_allocations' only FK is
 * invoice_id -> supplier_invoices(id) (no company predicate), so another
 * tenant's bill id is accepted.
 *
 * The consequence is in processBatch: its GL entry debits Accounts Payable for
 * the batch's FULL total (:136), while its subledger UPDATE is company-scoped
 * (:171) and therefore skips the foreign bill. AP is debited for a bill that is
 * never relieved. An over-allocation is likewise posted in full and drives
 * amount_paid past total_amount.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { createBatch } from '../../src/modules/accounting/services/ap/batchPaymentService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companyA = crypto.randomUUID(), companyB = crypto.randomUUID();
const user = crypto.randomUUID();
const supplierA = crypto.randomUUID(), supplierB = crypto.randomUUID();
const billA = crypto.randomUUID(), billB = crypto.randomUUID();

async function bill(id: string, company: string, supplier: string, number: string) {
  await pool.query(
    `INSERT INTO supplier_invoices(id,company_id,supplier_id,invoice_number,invoice_date,due_date,
       subtotal,tax_amount,total_amount,amount_paid,status,created_by)
     VALUES($1,$2,$3,$4,CURRENT_DATE - 5,CURRENT_DATE + 25,100,0,100,0,'approved',$5)`,
    [id, company, supplier, number, user],
  );
}

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2),($3,$4)', [companyA, 'K064 company A', companyB, 'K064 company B']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await pool.query('INSERT INTO suppliers(id,company_id,name) VALUES($1,$2,$3),($4,$5,$6)', [supplierA, companyA, 'K064 supplier A', supplierB, companyB, 'K064 supplier B']);
  await bill(billA, companyA, supplierA, 'K064-A-1');
  await bill(billB, companyB, supplierB, 'K064-B-1');
});

afterAll(async () => {
  const companies = [companyA, companyB];
  try {
    await pool.query('DELETE FROM payment_allocations WHERE payment_id IN (SELECT id FROM supplier_payments WHERE company_id = ANY($1))', [companies]);
    await pool.query('DELETE FROM supplier_payments WHERE company_id = ANY($1)', [companies]);
    await pool.query('DELETE FROM supplier_payment_batches WHERE company_id = ANY($1)', [companies]);
    await pool.query('DELETE FROM supplier_invoices WHERE company_id = ANY($1)', [companies]);
    await pool.query('DELETE FROM suppliers WHERE company_id = ANY($1)', [companies]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1)', [companies]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

it("refuses a batch line against another tenant's bill", async () => {
  await expect(createBatch(companyA, {
    paymentMethod: 'eft',
    payments: [{ supplierId: supplierA, invoiceAllocations: [{ invoiceId: billB, amount: 100 }] }],
  } as never, user)).rejects.toThrow();

  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM payment_allocations WHERE invoice_id=$1', [billB]);
  expect(rows[0].n).toBe(0);
});

it('refuses a batch line for more than the bill has outstanding', async () => {
  await expect(createBatch(companyA, {
    paymentMethod: 'eft',
    payments: [{ supplierId: supplierA, invoiceAllocations: [{ invoiceId: billA, amount: 500 }] }],
  } as never, user)).rejects.toThrow();

  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM payment_allocations WHERE invoice_id=$1', [billA]);
  expect(rows[0].n).toBe(0);
});
