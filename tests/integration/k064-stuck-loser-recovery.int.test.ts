// tests/integration/k064-stuck-loser-recovery.int.test.ts
//
// Review r1 MEDIUM-7 in the reviewer's own shape: 600 + 600 against a 1000 bill.
//
// PREVENTED: created concurrently, the two now serialise on the bill lock and
// the second is refused at CREATION (400), not left to fail at processing.
// RECOVERABLE: the stuck state can still be reached another way (it is seeded
// here as the unlocked creation left it) — the winner processes, the loser is
// refused, the loser is voided (single) or cancelled (batch) through the
// existing routes, and the remaining 400 is then paid: bill 1000 paid, AP
// debited exactly 1000.
// ONE LOCK ORDER: a single payment, a batch and an application naming the same
// two bills in opposite orders, released together, all succeed — no 40P01.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { ids, setUpFixture, tearDownFixture, type Fixture } from './supplier-ownership-fence.helpers';
import { bill, billState, processedPayment, today } from './ap-allocation-guards.helpers';
import { flow, text, type State } from './ap-payment-flow.helpers';
import supplierAllocations from '../../pages/api/accounting/supplier-allocations';
import supplierPayments from '../../pages/api/accounting/supplier-payments';

const describeIfDb = process.env.DATABASE_URL && process.env.JWT_SECRET ? describe : describe.skip;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

describeIfDb('K-064 review r1 MEDIUM-7 — the creation race and the stuck loser', () => {
  let fx: Fixture;
  const f = flow(() => fx);
  const q = (sql: string, p: unknown[]) => fx.pool.query(sql, p);
  const approved = (total = 1000) => bill(fx.pool, { supplier: ids.SUP_A, status: 'approved', total });

  /** Hold `billIds` FOR UPDATE, start each request 150ms apart, then release. */
  async function whileHeld(billIds: string[], starts: (() => Promise<State>)[]): Promise<State[]> {
    const holder = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    const client = await holder.connect();
    const running: Promise<State>[] = [];
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM supplier_invoices WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE', [billIds]);
      for (const start of starts) { running.push(start()); await pause(150); }
    } finally {
      await client.query('ROLLBACK');
      client.release();
      await holder.end();
    }
    return Promise.all(running);
  }

  /** The state the unlocked creation left: a second approved 600 on the same bill. */
  async function seedStuckSingle(billId: string): Promise<string> {
    const id = randomUUID();
    await q(`INSERT INTO supplier_payments (id, company_id, supplier_id, payment_number, payment_date, total_amount,
      payment_method, status, created_by) VALUES ($1, $2, $3, $4, CURRENT_DATE, 600, 'eft', 'approved', $5)`,
    [id, ids.A, ids.SUP_A, `K064-STUCK-${id.slice(0, 8)}`, ids.USER]);
    await q('INSERT INTO payment_allocations (payment_id, invoice_id, amount_allocated) VALUES ($1, $2, 600)', [id, billId]);
    return id;
  }
  async function seedStuckBatch(billId: string): Promise<string> {
    const batchId = randomUUID();
    await q(`INSERT INTO supplier_payment_batches (id, company_id, batch_date, payment_method, payment_count, total_amount,
      status, created_by) VALUES ($1, $2, CURRENT_DATE, 'eft', 1, 600, 'approved', $3)`, [batchId, ids.A, ids.USER]);
    const member = await seedStuckSingle(billId);
    await q('UPDATE supplier_payments SET batch_id = $1 WHERE id = $2', [batchId, member]);
    return batchId;
  }

  async function payTheRest(billId: string): Promise<void> {
    const paymentId = await f.approvedPayment(billId, 400);
    const done = await f.paymentAction('process', paymentId);
    expect(done.statusCode, text(done)).toBe(200);
  }

  beforeAll(async () => {
    assertDisposable();
    fx = await setUpFixture('K064 stuck');
  });
  afterAll(() => tearDownFixture(fx?.pool));

  it('PREVENTED: a batch and a single payment of 600 each, created at once on a 1000 bill — the second is refused at creation', async () => {
    const b = await approved();
    const [batch, single] = await whileHeld([b], [
      () => f.createBatch([{ billId: b, amount: 600 }]),
      () => f.createPayment(b, 600),
    ]);
    expect(batch.statusCode, text(batch)).toBe(200);
    expect(single.statusCode, text(single)).toBe(400);
    expect(text(single)).toContain('exceeds invoice');
  }, 20000);

  it.each([
    ['single payment', seedStuckSingle, (id: string) => f.paymentAction('void', id), 'payment'],
    ['batch', seedStuckBatch, (id: string) => f.batchAction('cancel', id), 'batch'],
  ] as const)('RECOVERABLE (%s loser): winner processes, loser refused, loser released, the rest is paid',
    async (_kind, seedLoser, release, table) => {
      const b = await approved();
      const ap = await f.apDebits();
      const winner = await f.approvedPayment(b, 600);
      const loser = await seedLoser(b);

      expect((await f.paymentAction('process', winner)).statusCode).toBe(200);
      const refused = table === 'payment'
        ? await f.paymentAction('process', loser) : await f.batchAction('process', loser);
      expect(refused.statusCode, text(refused)).toBe(400);
      expect(text(refused)).toContain('exceeds the R400.00 outstanding');

      const released = await release(loser);
      expect(released.statusCode, text(released)).toBe(200);
      expect(table === 'payment' ? await f.paymentStatus(loser) : await f.batchStatus(loser)).toBe('cancelled');

      await payTheRest(b);
      expect(await billState(fx.pool, b)).toEqual({ paid: 1000, status: 'paid' });
      expect(await f.apDebits()).toBe(ap + 1000);
    });

  it('ONE LOCK ORDER: a payment, a batch and an application naming two bills in opposite orders all succeed together', async () => {
    const [x, y] = [await approved(), await approved()];
    const [lo, hi] = x < y ? [x, y] : [y, x];
    const applyTo = await processedPayment(fx.pool, ids.SUP_A, 200);
    const results = await whileHeld([lo, hi], [
      () => fx.call(supplierAllocations, 'POST', { paymentId: applyTo,
        allocations: [{ invoiceId: hi, amount: 100 }, { invoiceId: lo, amount: 100 }] }),
      () => f.createBatch([{ billId: lo, amount: 100 }, { billId: hi, amount: 100 }]),
      () => fx.call(supplierPayments, 'POST', { supplierId: ids.SUP_A, paymentDate: today, totalAmount: 200,
        reference: 'K064-ORDER', allocations: [{ invoiceId: hi, amount: 100 }, { invoiceId: lo, amount: 100 }] }),
    ]);
    for (const r of results) {
      expect(r.statusCode, text(r)).toBeGreaterThanOrEqual(200);
      expect(r.statusCode, text(r)).toBeLessThan(300);
    }
    expect((await billState(fx.pool, lo)).paid).toBe(100);
    expect((await billState(fx.pool, hi)).paid).toBe(100);
  }, 30000);
});
