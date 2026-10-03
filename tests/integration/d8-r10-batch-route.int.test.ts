/**
 * D8 round 10, through the real routes (disposable auth fixture).
 * A  The HTTP void's bills loop is a plain UPDATE; with the bill held by another request the void used to wait as long
 *    as the holder held. It now runs under the flow's lock budget: 503 + SERVICE_UNAVAILABLE within ~5 s, nothing booked.
 * O4 Batch reversal took bills -> journal -> member payments; a member's MCP void takes payment -> bill. The pair
 *    deadlocked. Batch reversal now locks the members first.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { als } from '@/lib/als';
import { reverseBatch } from '@/modules/accounting/services/ap/batchPaymentReversal';
import { voidPaymentDocument } from '@/modules/accounting/services/core/paymentVoidService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { ids, setUpFixture, tearDownFixture, type Fixture } from './supplier-ownership-fence.helpers';
import { bill } from './ap-allocation-guards.helpers';
import { flow, text } from './ap-payment-flow.helpers';

const describeIfDb = process.env.DATABASE_URL && process.env.JWT_SECRET ? describe : describe.skip;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describeIfDb('D8 round 10 — flow lock budget and batch member order, through the routes', () => {
  let fx: Fixture;
  const f = flow(() => fx);
  const q = (s: string, p: unknown[]) => fx.pool.query(s, p);

  async function runTx(fn: () => Promise<unknown>, pauseOn?: (t: string) => boolean, onPause?: () => Promise<void>) {
    const cl: PoolClient = await fx.pool.connect();
    const orig = cl.query.bind(cl) as (...a: unknown[]) => Promise<unknown>;
    let fired = false;
    (cl as unknown as { query: unknown }).query = async (...a: unknown[]) => {
      const out = await orig(...a);
      const t = typeof a[0] === 'string' ? a[0] : (a[0] as { text?: string } | undefined)?.text ?? '';
      if (pauseOn && onPause && !fired && pauseOn(t)) { fired = true; await onPause(); }
      return out;
    };
    await orig('BEGIN');
    try {
      await als.run({ client: cl, userId: ids.USER, companyId: ids.A, claims: {} } as never, fn);
      await orig('COMMIT');
      return { ok: true };
    } catch (err) {
      await orig('ROLLBACK').catch(() => undefined);
      return { ok: false, error: `${(err as Error).name}: ${(err as Error).message}` };
    } finally {
      (cl as unknown as { query: unknown }).query = orig;
      cl.release();
    }
  }

  beforeAll(async () => {
    assertDisposable();
    fx = await setUpFixture('D8 r10 routes');
    const y = new Date().getFullYear();
    await q(`INSERT INTO fiscal_periods (company_id, period_name, period_number, fiscal_year, start_date, end_date, status)
      VALUES ($1, $2, 1, $3, $4, $5, 'open')`, [ids.A, `FY${y}`, y, `${y}-01-01`, `${y}-12-31`]);
  });
  afterAll(async () => { await tearDownFixture(fx?.pool); });

  it('A: HTTP void with its bill held (plain UPDATE) — 503 within the budget, the payment still processed', async () => {
    const x = await bill(fx.pool, { supplier: ids.SUP_A, status: 'approved' });
    const pay = await f.approvedPayment(x, 150);
    expect((await f.paymentAction('process', pay)).statusCode).toBe(200);
    const holder = await fx.pool.connect();
    await holder.query('BEGIN');
    await holder.query('SELECT id FROM supplier_invoices WHERE id = $1 FOR UPDATE', [x]);
    const release = setTimeout(() => { void holder.query('ROLLBACK'); }, 12000); // an unbounded mutant proceeds, late
    const started = Date.now();
    let state;
    try {
      state = await f.paymentAction('void', pay);
    } finally {
      clearTimeout(release);
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }
    expect(Date.now() - started).toBeLessThan(9000);
    expect(state.statusCode, text(state)).toBe(503);
    expect(text(state)).toMatch(/SERVICE_UNAVAILABLE/);
    expect(await f.paymentStatus(pay)).toBe('processed');
  }, 40000);

  it('O4: batch reversal holding its bills vs MCP void of a member — no deadlock', async () => {
    const b1 = await bill(fx.pool, { supplier: ids.SUP_A, status: 'approved' });
    const b2 = await bill(fx.pool, { supplier: ids.SUP_A, status: 'approved' });
    const batchId = await f.approvedBatch([{ billId: b1, amount: 300 }, { billId: b2, amount: 200 }]);
    expect((await f.batchAction('process', batchId)).statusCode).toBe(200);
    const member = String((await q(`SELECT pa.payment_id AS p FROM payment_allocations pa
      JOIN supplier_payments sp ON sp.id = pa.payment_id WHERE sp.batch_id = $1 AND pa.invoice_id = $2`, [batchId, b1])).rows[0].p);
    let other: Promise<Record<string, unknown>> = Promise.resolve({});
    const a = await runTx(() => reverseBatch(ids.A, batchId, ids.USER), (t) => /^\s*UPDATE supplier_invoices/.test(t), async () => {
      other = runTx(() => voidPaymentDocument(ids.A, 'supplier', member, ids.USER));
      await sleep(500);
    });
    const o = await other;
    expect(JSON.stringify([a, o])).not.toMatch(/deadlock|40P01/);
    expect(a.ok, JSON.stringify(a)).toBe(true);
  }, 40000);
});
