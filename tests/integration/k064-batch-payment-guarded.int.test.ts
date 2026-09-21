// tests/integration/k064-batch-payment-guarded.int.test.ts
//
// K-064: `createBatch` INSERTed `payment_allocations` straight from the body.
// R-068 since refuses a supplier from another company, but no statement read
// the BILLS: company B's bill, supplier A2's bill, an unapproved bill and an
// over-payment were all accepted, and `processBatch` debits AP for the batch
// total. Driven through batch-payments POST: `withAuth` COMMITs a 4xx, so every
// refusal must come before the first INSERT — the cases whose bad line is the
// LAST one prove that nothing earlier in the batch survived.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { ids, setUpFixture, tearDownFixture, type Fixture } from './supplier-ownership-fence.helpers';
import { allocationsOn, bill, billState, rowCount } from './ap-allocation-guards.helpers';
import batchPayments from '../../pages/api/accounting/batch-payments';
import batchPaymentsAction from '../../pages/api/accounting/batch-payments-action';

const describeIfDb = process.env.DATABASE_URL && process.env.JWT_SECRET ? describe : describe.skip;

type Line = { invoiceId: string; amount: number };

describeIfDb('K-064 — a batch checks every bill line before it writes anything', () => {
  let fx: Fixture;
  const create = async (payments: { supplierId: string; lines: Line[] }[]) =>
    fx.call(batchPayments, 'POST', { notes: 'K064', payments: payments.map((p) => ({
      supplierId: p.supplierId, invoiceAllocations: p.lines })) });

  /** Refused with `status`, and not one batch, payment or allocation row written. */
  async function expectRefusedClean(
    payments: { supplierId: string; lines: Line[] }[], status: number, text: string,
  ): Promise<void> {
    const batches = await rowCount(fx.pool, 'supplier_payment_batches');
    const pays = await rowCount(fx.pool, 'supplier_payments');
    const named = payments.flatMap((p) => p.lines.map((l) => l.invoiceId));
    const allocs = await allocationsOn(fx.pool, named);

    const state = await create(payments);

    expect(state.statusCode, JSON.stringify(state.body)).toBe(status);
    expect(JSON.stringify(state.body)).toContain(text);
    expect(await rowCount(fx.pool, 'supplier_payment_batches')).toBe(batches);
    expect(await rowCount(fx.pool, 'supplier_payments')).toBe(pays);
    expect(await allocationsOn(fx.pool, named)).toBe(allocs);
  }

  const approved = (supplier = ids.SUP_A, total = 1000) =>
    bill(fx.pool, { supplier, status: 'approved', total });

  beforeAll(async () => {
    assertDisposable();
    fx = await setUpFixture('K064');
  });
  afterAll(() => tearDownFixture(fx?.pool));

  it("refuses company B's bill as not found", async () => {
    const foreign = await bill(fx.pool, { company: ids.B, supplier: ids.SUP_B, status: 'approved' });
    await expectRefusedClean([{ supplierId: ids.SUP_A, lines: [{ invoiceId: foreign, amount: 100 }] }],
      400, 'not found');
    expect(await billState(fx.pool, foreign)).toEqual({ paid: 0, status: 'approved' });
  });

  it('refuses an over-payment', async () => {
    const b = await approved();
    await expectRefusedClean([{ supplierId: ids.SUP_A, lines: [{ invoiceId: b, amount: 1500 }] }],
      400, 'exceeds the R1000.00 outstanding');
  });

  it("refuses supplier A2's bill on supplier A's payment", async () => {
    const b = await approved(ids.SUP_A2);
    await expectRefusedClean([{ supplierId: ids.SUP_A, lines: [{ invoiceId: b, amount: 100 }] }],
      400, 'belongs to a different supplier');
  });

  it('refuses a pending_approval bill', async () => {
    const b = await bill(fx.pool, { supplier: ids.SUP_A, status: 'pending_approval' });
    await expectRefusedClean([{ supplierId: ids.SUP_A, lines: [{ invoiceId: b, amount: 100 }] }],
      400, 'is pending_approval and cannot receive a payment');
  });

  it('refuses a batch whose LAST line is the bad one, leaving the good lines unwritten', async () => {
    const [ok1, ok2, over] = [await approved(), await approved(), await approved()];
    await expectRefusedClean([
      { supplierId: ids.SUP_A, lines: [{ invoiceId: ok1, amount: 1000 }] },
      { supplierId: ids.SUP_A, lines: [{ invoiceId: ok2, amount: 500 }, { invoiceId: over, amount: 2000 }] },
    ], 400, 'exceeds the R1000.00 outstanding');
  });

  it('refuses one bill named by two payments, each within the balance alone', async () => {
    const b = await approved();
    await expectRefusedClean([
      { supplierId: ids.SUP_A, lines: [{ invoiceId: b, amount: 600 }] },
      { supplierId: ids.SUP_A, lines: [{ invoiceId: b, amount: 600 }] },
    ], 400, 'appears more than once');
  });

  it("counts an earlier unprocessed batch's allocation against the outstanding", async () => {
    const b = await approved();
    const first = await create([{ supplierId: ids.SUP_A, lines: [{ invoiceId: b, amount: 1000 }] }]);
    expect(first.statusCode, JSON.stringify(first.body)).toBe(200);
    await expectRefusedClean([{ supplierId: ids.SUP_A, lines: [{ invoiceId: b, amount: 1000 }] }],
      400, 'exceeds the R0.00 outstanding');
  });

  it('answers a bill held by another request 409 — contention, not a validation error', async () => {
    const b = await approved();
    const holder = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    const client = await holder.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM supplier_invoices WHERE id = $1 FOR UPDATE', [b]);
      await expectRefusedClean([{ supplierId: ids.SUP_A, lines: [{ invoiceId: b, amount: 100 }] }],
        409, 'retry');
    } finally {
      await client.query('ROLLBACK');
      client.release();
      await holder.end();
    }
  }, 20000);

  it('a valid batch processes with the AP debit equal to what its bills took', async () => {
    const [b1, b2] = [await approved(ids.SUP_A, 400), await approved(ids.SUP_A2, 300)];
    const state = await create([
      { supplierId: ids.SUP_A, lines: [{ invoiceId: b1, amount: 400 }] },
      { supplierId: ids.SUP_A2, lines: [{ invoiceId: b2, amount: 250 }] },
    ]);
    expect(state.statusCode, JSON.stringify(state.body)).toBe(200);
    const { rows } = await fx.pool.query(`SELECT DISTINCT sp.batch_id FROM supplier_payments sp
      JOIN payment_allocations pa ON pa.payment_id = sp.id WHERE pa.invoice_id = $1`, [b1]);
    const batchId = String(rows[0].batch_id);

    for (const action of ['approve', 'process']) {
      const r = await fx.call(batchPaymentsAction, 'POST', { action, id: batchId });
      expect(r.statusCode, JSON.stringify(r.body)).toBe(200);
    }

    expect(await billState(fx.pool, b1)).toEqual({ paid: 400, status: 'paid' });
    expect(await billState(fx.pool, b2)).toEqual({ paid: 250, status: 'partially_paid' });
    const { rows: je } = await fx.pool.query(`SELECT SUM(l.debit) AS dr, SUM(l.credit) AS cr,
        SUM(l.debit) FILTER (WHERE l.gl_account_id = $2) AS ap_dr
      FROM supplier_payment_batches b JOIN gl_journal_lines l ON l.journal_entry_id = b.gl_journal_entry_id
      WHERE b.id = $1`, [batchId, ids.AP_GL]);
    expect(Number(je[0].dr)).toBe(Number(je[0].cr));
    expect(Number(je[0].ap_dr)).toBe(650);
  });
});
