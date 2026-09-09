/**
 * K-066 — RED. `createSupplierPayment`
 * (src/modules/accounting/services/ap/supplierPaymentService.ts:133-218 on
 * origin/master) loads the bills it is about to allocate with
 *
 *   SELECT id, invoice_number, total_amount, amount_paid, balance
 *   FROM supplier_invoices
 *   WHERE id = ANY(${invoiceIds}::UUID[]) AND company_id = ${companyId}::UUID
 *
 * (lines 139-144). The predicate names the company and the ids — it does NOT
 * name `input.supplierId`, and it does NOT name `status`. The only check that
 * follows is a row-count equality (line 145) and `validatePaymentAllocations`,
 * which is pure and sees only the rows this query returned.
 *
 * So a payment raised against supplier A settles supplier B's bill, and a draft
 * or cancelled bill is settled as readily as an approved one. `processSupplier
 * Payment` then debits Accounts Payable and moves `amount_paid` on that bill.
 *
 * A fixed build rejects both.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { randomUUID } from 'crypto';
import { als } from '@/lib/als';
import { sql } from '@/lib/neon';
import { createSupplierPayment } from '@/modules/accounting/services/ap/supplierPaymentService';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const COMPANY = randomUUID();
const USER = randomUUID();
const TAG = `K066-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

let pool: Pool;
let supplierA: string;
let supplierB: string;
let bankAccount: string;

function run<T>(c: PoolClient, fn: () => Promise<T>): Promise<T> {
  return als.run({ client: c, userId: USER, companyId: COMPANY, claims: {} } as never, fn);
}

async function inTx<T>(fn: () => Promise<T>): Promise<T> {
  const c = await pool.connect();
  await c.query('BEGIN');
  try {
    const out = await run(c, fn);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

async function makeBill(supplierId: string, number: string, status: string): Promise<string> {
  const rows = (await sql`
    INSERT INTO supplier_invoices
      (company_id, supplier_id, invoice_number, invoice_date, subtotal, tax_rate,
       tax_amount, total_amount, amount_paid, status, created_by)
    VALUES (${COMPANY}::UUID, ${supplierId}::UUID, ${number}, '2026-06-30', 100, 15,
            15, 115, 0, ${status}, ${USER}::UUID)
    RETURNING id`) as { id: string }[];
  return rows[0]!.id;
}

describeIfDb('K-066 supplier payment allocation checks neither the supplier nor the bill status', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 4 });
    await sql`
      INSERT INTO companies (id, name, registration_number, created_at)
      VALUES (${COMPANY}::UUID, ${'K066 ' + TAG}, ${TAG}, NOW())`;
    const mkSupplier = async (n: string) => ((await sql`
      INSERT INTO suppliers (name, company_id) VALUES (${n}, ${COMPANY}::UUID)
      RETURNING id`) as { id: string }[])[0]!.id;
    supplierA = await mkSupplier('K066 A ' + TAG);
    supplierB = await mkSupplier('K066 B ' + TAG);
    bankAccount = ((await sql`
      INSERT INTO gl_accounts
        (company_id, account_code, account_name, account_type, account_subtype,
         normal_balance, is_active, is_system_account)
      VALUES (${COMPANY}::UUID, '1100', 'K066 Bank', 'asset', 'bank', 'debit', true, true)
      RETURNING id`) as { id: string }[])[0]!.id;
  });

  afterAll(async () => {
    await sql`DELETE FROM payment_allocations WHERE payment_id IN (
      SELECT id FROM supplier_payments WHERE company_id = ${COMPANY}::UUID)`;
    await sql`DELETE FROM supplier_payments WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM supplier_invoices WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM suppliers WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM gl_accounts WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM companies WHERE id = ${COMPANY}::UUID`;
    await pool.end();
  }, 60000);

  it("refuses a payment to supplier A that allocates supplier B's bill", async () => {
    const billOfB = await inTx(() => makeBill(supplierB, `${TAG}-B`, 'approved'));

    // THE CLAIM: this must be refused. On origin/master it succeeds.
    await expect(inTx(() => createSupplierPayment(COMPANY, {
      supplierId: supplierA,
      paymentDate: '2026-06-30',
      totalAmount: 115,
      bankAccountId: bankAccount,
      allocations: [{ invoiceId: billOfB, amount: 115 }],
    }, USER))).rejects.toThrow();

    const alloc = (await sql`
      SELECT count(*)::int AS n FROM payment_allocations WHERE invoice_id = ${billOfB}::UUID`) as { n: number }[];
    expect(alloc[0]!.n).toBe(0);
  }, 60000);

  it('refuses a payment that allocates a DRAFT bill', async () => {
    const draft = await inTx(() => makeBill(supplierA, `${TAG}-DRAFT`, 'draft'));
    await expect(inTx(() => createSupplierPayment(COMPANY, {
      supplierId: supplierA,
      paymentDate: '2026-06-30',
      totalAmount: 115,
      bankAccountId: bankAccount,
      allocations: [{ invoiceId: draft, amount: 115 }],
    }, USER))).rejects.toThrow();
  }, 60000);

  it('refuses a payment that allocates a CANCELLED bill', async () => {
    const cancelled = await inTx(() => makeBill(supplierA, `${TAG}-CANC`, 'cancelled'));
    await expect(inTx(() => createSupplierPayment(COMPANY, {
      supplierId: supplierA,
      paymentDate: '2026-06-30',
      totalAmount: 115,
      bankAccountId: bankAccount,
      allocations: [{ invoiceId: cancelled, amount: 115 }],
    }, USER))).rejects.toThrow();
  }, 60000);
});
