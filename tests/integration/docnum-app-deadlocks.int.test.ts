/**
 * DOCNUM, through the real services: a back-dated payment batch against a bulk bank allocation that crosses the
 * year end (brk-docnum A1).
 *
 * `createBatch` numbers the batch and then each of its payments, all in one transaction. Until migration 858 moved
 * BAT off CURRENT_DATE, a batch dated last year took THIS year's number key for the batch and LAST year's for its
 * payments. A bulk allocation that posts a last-year line and then a this-year line (writeBankBulkAllocate posts in
 * bank-line id order) takes the same two keys the other way round, and the pair deadlocked (40P01). The batch now
 * numbers in its own date's year, so batch and payments share one key.
 *
 * The interleave is driven by waits on pg_blocking_pids (by pid), not by sleeps.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { sql, withSavepoint } from '@/lib/neon';
import { allocateTransaction } from '@/modules/accounting/services/bank/bankAllocationService';
import { createBatch } from '@/modules/accounting/services/ap/batchPaymentService';
import { assertLocalFixtureDbUrl } from './fixtureDbGuard';
import { inTx, runOn, seedBankTx, seedBill } from './helpers/l1FifoFixture';
import { setup, teardown, type Ctx } from './d8-r4-helpers';
import { backendPid, errText, settle, waitForBlocked } from './helpers/jenumFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

let c: Ctx | undefined;

/** A request-shaped transaction left open on its own client: each `run` is one savepoint, as a bulk line is. */
async function openTx(): Promise<{ pid: number; run: <T>(fn: () => Promise<T>) => Promise<T>; end: (ok: boolean) => Promise<void> }> {
  const cl: PoolClient = await c!.fx.pool.connect();
  await cl.query('BEGIN');
  const pid = await backendPid(cl);
  let n = 0;
  return {
    pid,
    run: (fn) => runOn(c!.fx, cl, () => withSavepoint(`docnum_${++n}`, fn)),
    end: async (ok) => {
      try { await cl.query(ok ? 'COMMIT' : 'ROLLBACK'); } finally { cl.release(); }
    },
  };
}

const allocToExpense = (bankTxId: string) => allocateTransaction(
  c!.fx.companyId, bankTxId, c!.acct.expense!, c!.fx.userId, undefined, 'account', undefined, undefined);

describeIfDb('DOCNUM: in-app shapes that crossed the year end', () => {
  beforeAll(async () => {
    assertLocalFixtureDbUrl('DATABASE_URL', DATABASE_URL, ['isaflow_test', 'isaflow_schema_fixture']);
    c = await setup('DOCNUM-APP');
    await sql`INSERT INTO fiscal_periods (company_id, period_name, period_number, fiscal_year, start_date, end_date, status)
      VALUES (${c.fx.companyId}::UUID, ${`FY25 ${c.fx.tag}`}, 1, 2025, '2025-01-01', '2025-12-31', 'open')`;
  }, 120000);

  afterAll(async () => {
    if (!c) return;
    const id = c.fx.companyId;
    await sql`DELETE FROM payment_allocations WHERE payment_id IN (
      SELECT id FROM supplier_payments WHERE company_id = ${id}::UUID)`;
    await sql`DELETE FROM supplier_payments WHERE company_id = ${id}::UUID`;
    await sql`DELETE FROM supplier_payment_batches WHERE company_id = ${id}::UUID`;
    await teardown(c);
  }, 120000);

  it('createBatch dated last year vs a bulk allocation posting last year then this year: both commit', async () => {
    const bill = await seedBill(c!.fx, { number: 'DOCNUM-B', date: '2025-12-01', total: 100 });
    const line25 = await seedBankTx(c!.fx, { date: '2025-12-30', amount: -10, description: 'docnum 2025' });
    const line26 = await seedBankTx(c!.fx, { date: '2026-01-05', amount: -10, description: 'docnum 2026' });

    const bulk = await openTx();
    let bulkOk = false;
    try {
      await bulk.run(() => allocToExpense(line25)); // holds the 2025 key
      const batch = settle(inTx(c!.fx, () => createBatch(c!.fx.companyId, {
        batchDate: '2025-12-31', paymentMethod: 'eft',
        payments: [{ supplierId: c!.fx.supplierId, invoiceAllocations: [{ invoiceId: bill, amount: 100 }] }],
      } as never, c!.fx.userId)));
      await waitForBlocked(bulk.pid); // the batch now waits on the 2025 key (it used to hold 2026 first)
      const second = await settle(bulk.run(() => allocToExpense(line26)));
      expect(second.ok, second.ok ? '' : `bulk line 2: ${errText(second.error)}`).toBe(true);
      bulkOk = true;
      await bulk.end(true);
      const out = await batch;
      expect(out.ok, out.ok ? '' : `createBatch: ${errText(out.error)}`).toBe(true);
      const numbers = (await sql`SELECT batch_number FROM supplier_payment_batches
        WHERE company_id = ${c!.fx.companyId}::UUID`) as { batch_number: string }[];
      expect(numbers.map((r) => r.batch_number)).toEqual(['BAT-2025-00001']);
    } finally {
      if (!bulkOk) await bulk.end(false);
    }
  }, 60000);
});
