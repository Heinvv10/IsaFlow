/**
 * K-064 adjacent cases for the batch-creation gate.
 *
 * `createBatch` now routes every line through `planSupplierAllocationLines`
 * before it writes anything. The two cases the RED test does not cover are a
 * bill belonging to a DIFFERENT SUPPLIER inside the same tenant, and the same
 * bill named by two payments of one batch — which would otherwise pass the
 * per-payment balance check twice and settle the bill twice.
 *
 * The happy path runs the batch all the way through `processBatch`, because
 * that is where the damage landed: its journal debits Accounts Payable for the
 * batch's full total while the subledger UPDATE is company-scoped. The test
 * asserts the journal balances AND that the AP debit equals what the bills
 * actually took.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import {
  createBatch,
  approveBatch,
  processBatch,
} from '../../src/modules/accounting/services/ap/batchPaymentService';
import { clearSystemAccountCache } from '../../src/modules/accounting/services/gl/systemAccountResolver';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID(), user = crypto.randomUUID();
const supplierA = crypto.randomUUID(), supplierB = crypto.randomUUID();
const billA1 = crypto.randomUUID(), billA2 = crypto.randomUUID(), billB = crypto.randomUUID();
let bankAccount = '';

async function bill(id: string, supplier: string, number: string) {
  await pool.query(
    `INSERT INTO supplier_invoices(id,company_id,supplier_id,invoice_number,invoice_date,due_date,
       subtotal,tax_amount,total_amount,amount_paid,status,created_by)
     VALUES($1,$2,$3,$4,CURRENT_DATE - 5,CURRENT_DATE + 25,100,0,100,0,'approved',$5)`,
    [id, company, supplier, number, user],
  );
}

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'K064 guarded']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await pool.query('INSERT INTO suppliers(id,company_id,name) VALUES($1,$2,$3),($4,$5,$6)',
    [supplierA, company, 'K064G supplier A', supplierB, company, 'K064G supplier B']);
  await bill(billA1, supplierA, 'K064G-A-1');
  await bill(billA2, supplierA, 'K064G-A-2');
  await bill(billB, supplierB, 'K064G-B-1');
  const { rows } = await pool.query(
    `INSERT INTO gl_accounts(company_id,account_code,account_name,account_type,account_subtype,
       normal_balance,is_active,is_system_account)
     VALUES($1,'2100','K064G AP','liability','payable','credit',true,true),
           ($1,'1100','K064G Bank','asset','bank','debit',true,true)
     RETURNING id, account_subtype`, [company]);
  bankAccount = String(rows.find((r) => r.account_subtype === 'bank')!.id);
  clearSystemAccountCache(company);
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM payment_allocations WHERE payment_id IN (SELECT id FROM supplier_payments WHERE company_id=$1)', [company]);
    await pool.query('DELETE FROM supplier_payments WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM supplier_payment_batches WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM supplier_invoices WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM suppliers WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_journal_lines WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_journal_entries WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_account_balances WHERE gl_account_id IN (SELECT id FROM gl_accounts WHERE company_id=$1)', [company]);
    await pool.query('DELETE FROM gl_accounts WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM fiscal_periods WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=$1', [company]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
}, 60000);

it("refuses a batch line against another supplier's bill in the same tenant", async () => {
  await expect(createBatch(company, {
    paymentMethod: 'eft',
    payments: [{ supplierId: supplierA, invoiceAllocations: [{ invoiceId: billB, amount: 100 }] }],
  } as never, user)).rejects.toThrow(/different supplier/);

  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM payment_allocations WHERE invoice_id=$1', [billB]);
  expect(rows[0].n).toBe(0);
});

it('refuses one bill named by two payments of the same batch', async () => {
  await expect(createBatch(company, {
    paymentMethod: 'eft',
    payments: [
      { supplierId: supplierA, invoiceAllocations: [{ invoiceId: billA1, amount: 100 }] },
      { supplierId: supplierA, invoiceAllocations: [{ invoiceId: billA1, amount: 100 }] },
    ],
  } as never, user)).rejects.toThrow(/more than one payment/);

  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM payment_allocations WHERE invoice_id=$1', [billA1]);
  expect(rows[0].n).toBe(0);
});

it('processes a valid batch with a balanced journal that agrees with the bills', async () => {
  const batch = await createBatch(company, {
    paymentMethod: 'eft',
    bankAccountId: bankAccount,
    payments: [{
      supplierId: supplierA,
      invoiceAllocations: [{ invoiceId: billA1, amount: 100 }, { invoiceId: billA2, amount: 100 }],
    }],
  } as never, user);
  expect(batch.totalAmount).toBe(200);

  await approveBatch(company, batch.id, user);
  await processBatch(company, batch.id, user);

  const { rows: je } = await pool.query(
    `SELECT COALESCE(SUM(l.debit),0)::numeric AS dr, COALESCE(SUM(l.credit),0)::numeric AS cr
     FROM gl_journal_lines l
     JOIN supplier_payment_batches b ON b.gl_journal_entry_id = l.journal_entry_id
     WHERE b.id = $1 AND l.company_id = $2`, [batch.id, company]);
  expect(Number(je[0].dr)).toBe(200);
  expect(Number(je[0].cr)).toBe(Number(je[0].dr));

  const { rows: bills } = await pool.query(
    `SELECT COALESCE(SUM(amount_paid),0)::numeric AS paid, COUNT(*) FILTER (WHERE status='paid')::int AS settled
     FROM supplier_invoices WHERE id = ANY($1) AND company_id = $2`, [[billA1, billA2], company]);
  // The AP debit is exactly what the subledger took — the agreement the
  // unvalidated batch broke by debiting AP for bills it then skipped.
  expect(Number(bills[0].paid)).toBe(Number(je[0].dr));
  expect(bills[0].settled).toBe(2);
}, 60000);
