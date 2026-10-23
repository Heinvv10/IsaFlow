/**
 * Supplier allocations: a bill is never taken past its total by a sub-cent amount.
 *
 * `supplier_invoices.amount_paid` is NUMERIC(15,2), which rounds the decimal text
 * of a third decimal half away from zero (1.005 -> 1.01). The over-payment guard
 * (`buildLine`) judged `Math.round(1.005 * 100)` = 100 cents, and the writer
 * (`applyLineToBill`) bound 1.005, so R1.005 against a R1.00 bill passed and
 * stored R1.01 paid. Two defences, both pinned here: the REQUEST SHAPE refuses an
 * amount that is not whole cents, and `toCents` rounds the way the column does.
 *
 * Outcome-based: after the operation no bill of the company has
 * `amount_paid > total_amount`, or the operation is refused before any write.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { randomUUID } from 'crypto';
import { als } from '@/lib/als';
import { sql } from '@/lib/neon';
import { planSupplierAllocationLines, applyLineToBill } from '@/modules/accounting/services/ap/supplierAllocationLines';
import {
  planSupplierPaymentApplication,
  applySupplierPaymentPlan,
} from '@/modules/accounting/services/ap/supplierPaymentApplicationService';
import { SupplierPaymentRefusal } from '@/modules/accounting/services/ap/supplierPaymentRefusal';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const COMPANY = randomUUID();
const USER = randomUUID();
const TAG = `APWC-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

let pool: Pool;
let supplierId: string;

function run<T>(c: PoolClient, fn: () => Promise<T>): Promise<T> {
  return als.run({ client: c, userId: USER, companyId: COMPANY, claims: {} } as never, fn);
}

async function bill(c: PoolClient, number: string, total: number): Promise<string> {
  return (await c.query(
    `INSERT INTO supplier_invoices (company_id, supplier_id, invoice_number, invoice_date, due_date, subtotal,
       tax_amount, total_amount, amount_paid, status, created_by)
     VALUES ($1, $2, $3, '2026-06-30', '2026-07-30', $4, 0, $4, 0, 'approved', $5::UUID) RETURNING id`,
    [COMPANY, supplierId, `${TAG}-${number}`, total, USER],
  )).rows[0].id as string;
}

async function overPaid(c: PoolClient): Promise<unknown[]> {
  return (await c.query(
    `SELECT invoice_number, amount_paid, total_amount FROM supplier_invoices
      WHERE company_id = $1 AND amount_paid > total_amount`, [COMPANY])).rows;
}

describeIfDb('supplier allocations: whole cents', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 2 });
    await sql`INSERT INTO companies (id, name, registration_number, created_at)
      VALUES (${COMPANY}::UUID, ${TAG}, ${TAG}, NOW())`;
    supplierId = ((await sql`INSERT INTO suppliers (name, company_id)
      VALUES (${'S ' + TAG}, ${COMPANY}::UUID) RETURNING id`) as { id: string }[])[0]!.id;
  });

  afterAll(async () => {
    await sql`DELETE FROM payment_allocations WHERE invoice_id IN (
      SELECT id FROM supplier_invoices WHERE company_id = ${COMPANY}::UUID)`;
    await sql`DELETE FROM supplier_payments WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM supplier_invoices WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM suppliers WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM companies WHERE id = ${COMPANY}::UUID`;
    await pool.end();
  }, 60000);

  it.each([[1.005, 1.0], [0.005, 0.01], [10.005, 10.0]])(
    'plan + apply of %s onto a %s bill is refused and writes nothing', async (amount, total) => {
      const c = await pool.connect();
      await c.query('BEGIN');
      try {
        const id = await bill(c, `line-${amount}`, total);
        await expect(run(c, async () => {
          const plan = await planSupplierAllocationLines(COMPANY, [{ invoiceId: id, amount }], { paymentId: null, supplierId });
          for (const l of plan.lines) await applyLineToBill(COMPANY, l);
        })).rejects.toBeInstanceOf(SupplierPaymentRefusal);
        expect(await overPaid(c)).toEqual([]);
        expect(Number((await c.query(`SELECT amount_paid FROM supplier_invoices WHERE id = $1`, [id])).rows[0].amount_paid)).toBe(0);
      } finally {
        await c.query('ROLLBACK').catch(() => {});
        c.release();
      }
    }, 60000);

  it('the payment-apply path (REST supplier-allocations) refuses 1.005 onto a 1.00 bill', async () => {
    const c = await pool.connect();
    await c.query('BEGIN');
    try {
      const id = await bill(c, 'rest', 1);
      const pay = (await c.query(
        `INSERT INTO supplier_payments (company_id, supplier_id, payment_number, payment_date, total_amount, status, created_by)
         VALUES ($1, $2, $3, '2026-07-01', 5, 'processed', $4::UUID) RETURNING id`,
        [COMPANY, supplierId, `${TAG}-p`, USER])).rows[0].id as string;
      await expect(run(c, async () => {
        const plan = await planSupplierPaymentApplication(COMPANY, pay, [{ invoiceId: id, amount: 1.005 }]);
        await applySupplierPaymentPlan(COMPANY, plan, USER);
      })).rejects.toBeInstanceOf(SupplierPaymentRefusal);
      expect(await overPaid(c)).toEqual([]);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  }, 60000);

  it('still pays a bill exactly, and a second line of a cent more is refused', async () => {
    const c = await pool.connect();
    await c.query('BEGIN');
    try {
      const id = await bill(c, 'exact', 100);
      await run(c, async () => {
        const plan = await planSupplierAllocationLines(COMPANY, [{ invoiceId: id, amount: 100 }], { paymentId: null, supplierId });
        for (const l of plan.lines) await applyLineToBill(COMPANY, l);
      });
      expect((await c.query(`SELECT amount_paid, status FROM supplier_invoices WHERE id = $1`, [id])).rows[0])
        .toMatchObject({ amount_paid: '100.00', status: 'paid' });
      await expect(run(c, () => planSupplierAllocationLines(
        COMPANY, [{ invoiceId: id, amount: 0.01 }], { paymentId: null, supplierId },
      ))).rejects.toBeInstanceOf(SupplierPaymentRefusal);
      expect(await overPaid(c)).toEqual([]);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  }, 60000);
});
