// tests/integration/k064-reservations-cents-cancel.int.test.ts
//
// Review r1 findings 4, 5 and 7, each by outcome through the real handlers.
//
// 4. Which payments RESERVE a bill's outstanding before `amount_paid` moves:
//    draft and approved do; cancelled does not; processed does not either —
//    its money is already in `amount_paid`, so counting it again double-counts.
// 5. The outstanding is compared in integer cents with no tolerance.
// 7. `createSupplierPayment` locks the bills before it reads what is promised,
//    so it and a concurrent batch cannot both take the same outstanding; and an
//    approved document that can no longer process has a way out (cancel).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { ids, setUpFixture, tearDownFixture, type Fixture } from './supplier-ownership-fence.helpers';
import { allocationsOn, bill } from './ap-allocation-guards.helpers';
import { flow, text } from './ap-payment-flow.helpers';

const describeIfDb = process.env.DATABASE_URL && process.env.JWT_SECRET ? describe : describe.skip;

describeIfDb('K-064 review r1 — reservations, cents, locked creation, cancel', () => {
  let fx: Fixture;
  const f = flow(() => fx);
  const approved = (total = 1000, paid = 0) =>
    bill(fx.pool, { supplier: ids.SUP_A, status: paid ? 'partially_paid' : 'approved', total, paid });
  const batchOf = (billId: string, amount: number) => f.createBatch([{ billId, amount }]);

  beforeAll(async () => {
    assertDisposable();
    fx = await setUpFixture('K064 r4');
  });
  afterAll(() => tearDownFixture(fx?.pool));

  // ── 4. reservations ────────────────────────────────────────────────────────
  it('an APPROVED unprocessed payment reserves the bill', async () => {
    const b = await approved();
    await f.approvedPayment(b, 1000);
    const state = await batchOf(b, 1000);
    expect(state.statusCode, text(state)).toBe(400);
    expect(text(state)).toContain('exceeds the R0.00 outstanding');
  });

  it('a DRAFT unprocessed payment reserves the bill', async () => {
    const b = await approved();
    expect((await f.createPayment(b, 1000)).statusCode).toBe(201);
    expect((await batchOf(b, 1000)).statusCode).toBe(400);
  });

  it('a CANCELLED payment does not reserve the bill', async () => {
    const b = await approved();
    const paymentId = await f.approvedPayment(b, 1000);
    const cancel = await f.paymentAction('cancel', paymentId);
    expect(cancel.statusCode, text(cancel)).toBe(200);
    expect(await f.paymentStatus(paymentId)).toBe('cancelled');
    const state = await batchOf(b, 1000);
    expect(state.statusCode, text(state)).toBe(200);
  });

  it('a PROCESSED payment reserves nothing beyond what amount_paid already holds', async () => {
    const b = await approved();
    const paymentId = await f.approvedPayment(b, 400);
    expect((await f.paymentAction('process', paymentId)).statusCode).toBe(200);
    expect((await batchOf(b, 600.01)).statusCode).toBe(400);
    const exact = await batchOf(b, 600);
    expect(exact.statusCode, text(exact)).toBe(200);
  });

  // ── 5. integer cents, no tolerance ────────────────────────────────────────
  it('a R100.00 bill takes R100.00 and refuses R100.01', async () => {
    const b = await approved(100);
    const over = await batchOf(b, 100.01);
    expect(over.statusCode, text(over)).toBe(400);
    expect(text(over)).toContain('R100.01 exceeds the R100.00 outstanding');
    expect((await batchOf(b, 100)).statusCode).toBe(200);
  });

  it('a fully paid bill refuses R0.01', async () => {
    const b = await approved(1000, 1000);
    const state = await batchOf(b, 0.01);
    expect(state.statusCode, text(state)).toBe(400);
    expect(text(state)).toContain('exceeds the R0.00 outstanding');
  });

  // ── 7. locked creation, and the way out ───────────────────────────────────
  it('a single payment waits for a concurrent batch on the same bill, then sees its reservation', async () => {
    const b = await approved();
    const holder = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    const client = await holder.connect();
    let batch: Promise<{ statusCode: number }>, single: Promise<{ statusCode: number }>;
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM supplier_invoices WHERE id = $1 FOR UPDATE', [b]);
      batch = batchOf(b, 1000);
      await new Promise((r) => setTimeout(r, 150));
      single = f.createPayment(b, 1000);
      await new Promise((r) => setTimeout(r, 150));
    } finally {
      await client.query('ROLLBACK');
      client.release();
      await holder.end();
    }
    const [bs, ss] = [await batch!, await single!];
    expect(bs.statusCode).toBe(200);
    expect(ss.statusCode).toBe(400);
    const { rows } = await fx.pool.query(`SELECT COALESCE(SUM(pa.amount_allocated), 0) AS n
      FROM payment_allocations pa JOIN supplier_payments sp ON sp.id = pa.payment_id
      WHERE pa.invoice_id = $1 AND sp.status <> 'cancelled'`, [b]);
    expect(Number(rows[0].n)).toBe(1000);
  }, 20000);

  it('an approved batch can be cancelled, freeing its reservation', async () => {
    const b = await approved();
    const batchId = await f.approvedBatch([{ billId: b, amount: 1000 }]);
    const cancel = await f.batchAction('cancel', batchId);
    expect(cancel.statusCode, text(cancel)).toBe(200);
    expect(await f.batchStatus(batchId)).toBe('cancelled');
    expect(await f.paymentStatus(await f.memberOf(batchId))).toBe('cancelled');
    expect((await f.createPayment(b, 1000)).statusCode).toBe(201);
  });

  it('a processed batch cannot be cancelled, and says so', async () => {
    const b = await approved();
    const batchId = await f.approvedBatch([{ billId: b, amount: 100 }]);
    expect((await f.batchAction('process', batchId)).statusCode).toBe(200);
    const cancel = await f.batchAction('cancel', batchId);
    expect(cancel.statusCode, text(cancel)).toBe(400);
    expect(await f.batchStatus(batchId)).toBe('processed');
  });

  it('a processed payment cannot be cancelled, and a batch member is cancelled through its batch', async () => {
    const b = await approved();
    const paymentId = await f.approvedPayment(b, 100);
    expect((await f.paymentAction('process', paymentId)).statusCode).toBe(200);
    const processed = await f.paymentAction('cancel', paymentId);
    expect(processed.statusCode, text(processed)).toBe(400);
    expect(await f.paymentStatus(paymentId)).toBe('processed');

    const batchId = await f.approvedBatch([{ billId: await approved(), amount: 100 }]);
    const member = await f.memberOf(batchId);
    const alone = await f.paymentAction('cancel', member);
    expect(alone.statusCode, text(alone)).toBe(400);
    expect(await f.paymentStatus(member)).toBe('approved');
    expect(await allocationsOn(fx.pool, [b])).toBe(1);
  });
});
