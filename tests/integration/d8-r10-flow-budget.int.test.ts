/**
 * D8 round 10 (lead, add-on A): a D8 flow's WHOLE locking section runs under one core/rowLockBudget budget, so a
 * plain UPDATE in its loop — not only an explicit FOR UPDATE — waits at most 5 s. A second connection holds a row
 * that only such an UPDATE touches; the flow refuses within the budget with RowLockTimeoutError (503 at the
 * routes) and books nothing. Each case runs under a 15 s statement_timeout, so an unbounded mutant fails on time.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { RowLockTimeoutError } from '@/modules/accounting/services/core/rowLockBudget';
import { voidSupplierPayment } from '@/modules/accounting/services/ap/supplierPaymentWorkflowService';
import { cancelCustomerPayment } from '@/modules/accounting/services/ar/customerPaymentAllocationService';
import { voidPaymentDocument } from '@/modules/accounting/services/core/paymentVoidService';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { runOn } from './helpers/l1FifoFixture';
import { confirmedReceipt, diff, postedBill, postedInvoice, processedPayment, setup, tb, teardown, type Ctx } from './d8-r4-helpers';

let c: Ctx;
type Row = Record<string, unknown>;
const one = async (q: Promise<unknown>) => ((await q) as Row[])[0]!;

/** Another connection holds `table` row `id` while `flow` runs in its own request transaction. */
async function againstHolder(table: 'customer_invoices' | 'supplier_invoices', id: string, flow: () => Promise<unknown>) {
  const holder = await c.fx.pool.connect();
  await holder.query('BEGIN');
  await holder.query(`SELECT id FROM ${table} WHERE id = $1 FOR UPDATE`, [id]);
  const cl = await c.fx.pool.connect();
  const started = Date.now();
  let err: unknown = null;
  try {
    await cl.query('BEGIN');
    await cl.query("SET LOCAL statement_timeout = '15s'");
    await runOn(c.fx, cl, flow).catch((e: unknown) => { err = e; });
  } finally {
    await cl.query('ROLLBACK');
    cl.release();
    await holder.query('ROLLBACK');
    holder.release();
  }
  return { err, ms: Date.now() - started };
}
function expectBounded(r: { err: unknown; ms: number }) {
  expect(r.err, String(r.err)).toBeInstanceOf(RowLockTimeoutError);
  expect(r.ms).toBeGreaterThan(4000);
  expect(r.ms).toBeLessThan(9000);
}

describe.skipIf(!process.env.DATABASE_URL)('D8 round 10: a plain UPDATE in a flow\'s loop waits under the flow\'s budget', () => {
  beforeAll(async () => {
    assertNotProductionDb('D8 round 10 flow budget');
    c = await setup('D8R10F');
  }, 120000);
  afterAll(async () => { await teardown(c); }, 120000);

  it('HTTP void: the bill held (only the bills loop\'s UPDATE touches it) — refused within the budget, nothing booked', async () => {
    const bill = await postedBill(c);
    const pay = await processedPayment(c, bill.id, 400);
    const t0 = await tb(c);
    expectBounded(await againstHolder('supplier_invoices', bill.id, () => voidSupplierPayment(c.fx.companyId, pay.id, c.fx.userId)));
    expect((await one(sql`SELECT status FROM supplier_payments WHERE id = ${pay.id}::UUID`)).status).toBe('processed');
    expect(diff(t0, await tb(c))).toMatchObject({ ap: 0, bank: 0 });
  }, 30000);

  it('receipt cancel: the invoice held (only the invoices loop\'s UPDATE touches it) — refused within the budget', async () => {
    const inv = await postedInvoice(c);
    const rc = await confirmedReceipt(c, inv.id, 300);
    const t0 = await tb(c);
    expectBounded(await againstHolder('customer_invoices', inv.id, () => cancelCustomerPayment(c.fx.companyId, rc.id, c.fx.userId)));
    expect((await one(sql`SELECT status FROM customer_payments WHERE id = ${rc.id}::UUID`)).status).toBe('confirmed');
    expect(diff(t0, await tb(c))).toMatchObject({ ar: 0, bank: 0 });
  }, 30000);

  it('MCP void: the bill held (only the unwind\'s UPDATE touches it) — refused within the budget', async () => {
    const bill = await postedBill(c);
    const pay = await processedPayment(c, bill.id, 200);
    const t0 = await tb(c);
    expectBounded(await againstHolder('supplier_invoices', bill.id,
      () => voidPaymentDocument(c.fx.companyId, 'supplier', pay.id, c.fx.userId)));
    expect((await one(sql`SELECT status FROM supplier_payments WHERE id = ${pay.id}::UUID`)).status).toBe('processed');
    expect(diff(t0, await tb(c))).toMatchObject({ ap: 0, bank: 0 });
  }, 30000);
});
