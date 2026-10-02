/**
 * D8 round 6 (blind review of 69e4fe48b, findings 1 and 3), HTTP single void.
 *
 * 1. A payment journal already OUT of the ledger (reversed from the GL) used to
 *    take an early return in lockBankLegOf that skipped its bank lines: a line
 *    matched to it stayed 'matched' against cash the GL no longer holds, and a
 *    reconciled line did not refuse the void. Now the lines are locked, checked
 *    and freed exactly as for a standing journal; only the contra is skipped.
 * 3. lockJournalAndUnmatch re-reads the chain head under lock: a reversal that
 *    lands after lockBankLegOf's walk is a typed, retryable refusal, not an
 *    untyped "already reversed" from reverseJournalEntry.
 * Batch reversal's twin cases are in d8-r2-batch-reversal-chain-head.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { reverseJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostingService';
import { voidSupplierPayment } from '@/modules/accounting/services/ap/supplierPaymentWorkflowService';
import { SupplierPaymentRefusal } from '@/modules/accounting/services/ap/supplierPaymentRefusal';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { inTx, runOn } from './helpers/l1FifoFixture';
import { buildChain, diff, postedBill, processedPayment, setup, tb, teardown, type Ctx } from './d8-r4-helpers';

let c: Ctx;
type Row = Record<string, unknown>;

/** A bank line matched (or reconciled) to the payment journal's bank leg, as a statement match leaves it. */
async function bankLineOn(je: string, status: 'matched' | 'reconciled'): Promise<string> {
  const [l] = (await sql`
    SELECT id FROM gl_journal_lines
    WHERE journal_entry_id = ${je}::UUID AND gl_account_id = ${c.fx.bankAccountId}::UUID AND company_id = ${c.fx.companyId}::UUID`) as Row[];
  const [bt] = (await sql`
    INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date, amount, description, status, matched_journal_line_id)
    VALUES (${c.fx.companyId}::UUID, ${c.fx.bankAccountId}::UUID, '2026-05-20', -400, ${`D8R6 ${status} ${je.slice(0, 8)}`},
            ${status}, ${String(l!.id)}::UUID)
    RETURNING id`) as Row[];
  return String(bt!.id);
}

const line = async (id: string) => ((await sql`
  SELECT status, matched_journal_line_id FROM bank_transactions WHERE id = ${id}::UUID`) as Row[])[0]!;
const paymentStatus = async (id: string) => String(((await sql`
  SELECT status FROM supplier_payments WHERE id = ${id}::UUID`) as Row[])[0]!.status);

/** A committed transaction whose client runs `onWalk` right after its `fireAt`-th chain-head walk returns. */
async function hookedTx<T>(fn: () => Promise<T>, fireAt: number, onWalk: () => Promise<void>): Promise<T> {
  const cl = await c.fx.pool.connect();
  const orig = cl.query.bind(cl) as (...a: unknown[]) => Promise<unknown>;
  let n = 0;
  (cl as unknown as { query: unknown }).query = async (...a: unknown[]) => {
    const out = await orig(...a);
    if (typeof a[0] === 'string' && a[0].includes('ARRAY[id] AS path') && ++n === fireAt) await onWalk();
    return out;
  };
  await orig('BEGIN');
  try {
    const v = await runOn(c.fx, cl, fn);
    await orig('COMMIT');
    return v;
  } catch (err) {
    await orig('ROLLBACK');
    throw err;
  } finally {
    (cl as unknown as { query: unknown }).query = orig;
    cl.release();
  }
}

describe.skipIf(!process.env.DATABASE_URL)('D8 round 6: an out-of-ledger payment journal still frees and guards its bank lines', () => {
  beforeAll(async () => {
    assertNotProductionDb('D8 round 6 out-chain bank lines');
    c = await setup('D8R6B');
  }, 120000);
  afterAll(async () => {
    if (c) await sql`UPDATE bank_transactions SET matched_journal_line_id = NULL WHERE company_id = ${c.fx.companyId}::UUID`;
    await teardown(c);
  }, 120000);

  it('voids the payment, frees the matched line, and posts nothing', async () => {
    const bill = await postedBill(c);
    const pay = await processedPayment(c, bill.id, 400);
    const bt = await bankLineOn(pay.je, 'matched');
    await buildChain(c, pay.je, 1);
    const t0 = await tb(c);

    await inTx(c.fx, () => voidSupplierPayment(c.fx.companyId, pay.id, c.fx.userId));

    expect(await line(bt)).toEqual({ status: 'imported', matched_journal_line_id: null });
    expect(await paymentStatus(pay.id)).toBe('cancelled');
    expect(diff(t0, await tb(c))).toMatchObject({ ap: 0, bank: 0 });
  });

  it('refuses when the line is reconciled, changing nothing', async () => {
    const bill = await postedBill(c);
    const pay = await processedPayment(c, bill.id, 400);
    const bt = await bankLineOn(pay.je, 'reconciled');
    await buildChain(c, pay.je, 1);

    const err = await inTx(c.fx, () => voidSupplierPayment(c.fx.companyId, pay.id, c.fx.userId)).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(SupplierPaymentRefusal);
    expect((err as Error).message).toMatch(/reconciled in the Sage import/); // the reconciled-cash rule, not contention
    expect((await line(bt)).status).toBe('reconciled');
    expect(await paymentStatus(pay.id)).toBe('processed');
  });

  it('a reversal of the head landing after the bank-leg walk is a retryable refusal, not "already reversed"', async () => {
    const bill = await postedBill(c);
    const pay = await processedPayment(c, bill.id, 300);
    const chain = await buildChain(c, pay.je, 2); // standing through R2
    const t0 = await tb(c);

    const err = await hookedTx(() => voidSupplierPayment(c.fx.companyId, pay.id, c.fx.userId), 1, async () => {
      await inTx(c.fx, () => reverseJournalEntry(c.fx.companyId, chain[2]!, c.fx.userId));
    }).then(() => null, (e: unknown) => e);

    expect(err).toBeInstanceOf(SupplierPaymentRefusal);
    expect((err as SupplierPaymentRefusal).retryable).toBe(true);
    expect(await paymentStatus(pay.id)).toBe('processed');
    expect(diff(t0, await tb(c))).toMatchObject({ ap: -300, bank: 300 }); // only the concurrent reversal moved
  });
});
