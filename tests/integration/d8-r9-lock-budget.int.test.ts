/**
 * D8 round 9 (review rev-d8-9ecdfa549, findings 1 and 4).
 *
 * 1. Every row lock the reversal flows take waits under `core/rowLockBudget.withRowLockBudget`: a request that
 *    holds the row makes the flow refuse within ~5 s with its typed, retryable error, booking nothing — never an
 *    unbounded wait on a pooled connection. Each case runs under a 15 s statement_timeout, so a mutant without
 *    the bound fails on the timing assertion instead of hanging.
 * 4. Guards no test pinned: lockChainHead's budget is one deadline across passes; lockJournalAndUnmatch refuses a
 *    head that MOVED (still standing, new head); receipt cancel refuses a receipt confirmed between its peek and
 *    its lock; the journals lock takes its rows in id order.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { sql } from '@/lib/neon';
import { reverseJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostingService';
import { JournalReversalLockTimeoutError } from '@/modules/accounting/services/gl/journalEntryReversalClaim';
import { RowLockTimeoutError } from '@/modules/accounting/services/core/rowLockBudget';
import { cancelCustomerPayment, confirmCustomerPayment } from '@/modules/accounting/services/ar/customerPaymentAllocationService';
import { createCustomerPayment } from '@/modules/accounting/services/ar/customerPaymentService';
import { cancelCustomerInvoice } from '@/modules/accounting/services/ar/customerInvoiceCancelService';
import { cancelSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { voidSupplierPayment } from '@/modules/accounting/services/ap/supplierPaymentWorkflowService';
import { SupplierPaymentRefusal } from '@/modules/accounting/services/ap/supplierPaymentRefusal';
import { lockJournalAndUnmatch } from '@/modules/accounting/services/ap/paymentJournalReversal';
import { prepareInvoiceDelete } from '@/modules/accounting/services/core/softDeleteJournalService';
import { lockStandingChainHead } from '@/modules/accounting/services/shared/journalChainHead';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { inTx, runOn } from './helpers/l1FifoFixture';
import {
  buildChain, confirmedReceipt, diff, openTx, postedBill, postedInvoice, processedPayment, setup, sleep, tb, teardown,
  type Ctx,
} from './d8-r4-helpers';

let c: Ctx;
type Row = Record<string, unknown>;
const one = async (q: Promise<unknown>) => ((await q) as Row[])[0]!;

/** Run `fn` in a committed request transaction on its own client; `onHit` fires after the `fireAt`-th matching query. */
async function hooked<T>(fn: () => Promise<T>, match: (t: string) => boolean, fireAt: number,
  onHit: () => Promise<void>, setup?: (cl: PoolClient) => Promise<void>): Promise<T> {
  const cl = await c.fx.pool.connect();
  const orig = cl.query.bind(cl) as (...a: unknown[]) => Promise<unknown>;
  let n = 0;
  (cl as unknown as { query: unknown }).query = async (...a: unknown[]) => {
    const out = await orig(...a);
    const t = typeof a[0] === 'string' ? a[0] : (a[0] as { text?: string } | undefined)?.text ?? '';
    if (match(t) && ++n === fireAt) await onHit();
    return out;
  };
  await orig('BEGIN');
  try {
    await orig("SET LOCAL statement_timeout = '15s'");
    if (setup) await setup(cl);
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
const never = () => false;

/** Another request holds `table` row `id` FOR UPDATE while `flow` runs; returns the flow's error and elapsed ms. */
async function againstHolder(table: 'gl_journal_entries' | 'customer_invoices' | 'supplier_invoices', id: string,
  flow: () => Promise<unknown>): Promise<{ err: unknown; ms: number }> {
  const holder = await c.fx.pool.connect();
  await holder.query('BEGIN');
  await holder.query(`SELECT id FROM ${table} WHERE id = $1 FOR UPDATE`, [id]);
  const started = Date.now();
  let err: unknown = null;
  try {
    await hooked(flow, never, 0, async () => undefined).catch((e: unknown) => { err = e; });
  } finally {
    await holder.query('ROLLBACK');
    holder.release();
  }
  return { err, ms: Date.now() - started };
}
function expectBounded(r: { err: unknown; ms: number }, cls: new (...a: never[]) => Error) {
  expect(r.err, String(r.err)).toBeInstanceOf(cls);
  expect(r.ms).toBeGreaterThan(4000);
  expect(r.ms).toBeLessThan(9000);
}

describe.skipIf(!process.env.DATABASE_URL)('D8 round 9: every row lock of the reversal flows is bounded', () => {
  beforeAll(async () => {
    assertNotProductionDb('D8 round 9 lock budget');
    c = await setup('D8R9B');
  }, 120000);
  afterAll(async () => { await teardown(c); }, 120000);

  it('receipt cancel: its journal held — refuses within the budget, the receipt stays confirmed, nothing booked', async () => {
    const inv = await postedInvoice(c);
    const rc = await confirmedReceipt(c, inv.id, 400);
    const t0 = await tb(c);
    expectBounded(await againstHolder('gl_journal_entries', rc.je, () => cancelCustomerPayment(c.fx.companyId, rc.id, c.fx.userId)),
      JournalReversalLockTimeoutError);
    expect((await one(sql`SELECT status FROM customer_payments WHERE id = ${rc.id}::UUID`)).status).toBe('confirmed');
    expect(diff(t0, await tb(c))).toMatchObject({ ar: 0, bank: 0 });
  }, 30000);

  it('HTTP void: its journal held — refuses within the budget, the payment stays processed', async () => {
    const bill = await postedBill(c);
    const pay = await processedPayment(c, bill.id, 400);
    expectBounded(await againstHolder('gl_journal_entries', pay.je, () => voidSupplierPayment(c.fx.companyId, pay.id, c.fx.userId)),
      JournalReversalLockTimeoutError);
    expect((await one(sql`SELECT status FROM supplier_payments WHERE id = ${pay.id}::UUID`)).status).toBe('processed');
  }, 30000);

  it('AR invoice cancel: the invoice held, then the journal held — each refuses within the budget', async () => {
    const inv = await postedInvoice(c);
    expectBounded(await againstHolder('customer_invoices', inv.id, () => cancelCustomerInvoice(c.fx.companyId, inv.id, c.fx.userId)),
      RowLockTimeoutError);
    expectBounded(await againstHolder('gl_journal_entries', inv.je, () => cancelCustomerInvoice(c.fx.companyId, inv.id, c.fx.userId)),
      JournalReversalLockTimeoutError);
    expect((await one(sql`SELECT status FROM customer_invoices WHERE id = ${inv.id}::UUID`)).status).not.toBe('cancelled');
  }, 40000);

  it('AP bill cancel: the bill held — refuses within the budget', async () => {
    const bill = await postedBill(c);
    expectBounded(await againstHolder('supplier_invoices', bill.id, () => cancelSupplierInvoice(c.fx.companyId, bill.id, c.fx.userId)),
      RowLockTimeoutError);
  }, 30000);

  it('invoice soft delete: its journal held — refuses within the budget', async () => {
    const inv = await postedInvoice(c);
    expectBounded(await againstHolder('gl_journal_entries', inv.je,
      () => prepareInvoiceDelete('customer_invoice', inv.id, c.fx.companyId, c.fx.userId)), JournalReversalLockTimeoutError);
  }, 30000);

  it('lockChainHead: ONE deadline across passes — a second pass waits only what the first left', async () => {
    const inv = await postedInvoice(c);
    // A reverses X twice and holds X (its claim) for 3 s; the flow's first pass waits on X, finds it reversed,
    // and its second pass meets R2 — held by C from the moment the first pass returns.
    const a = await openTx(c.fx, async () => {
      const r = await reverseJournalEntry(c.fx.companyId, inv.je, c.fx.userId);
      return (await reverseJournalEntry(c.fx.companyId, r.id, c.fx.userId)).id;
    });
    const r2 = a.value;
    setTimeout(() => { void a.commit(); }, 3000);
    const holder = await c.fx.pool.connect();
    const started = Date.now();
    let err: unknown = null;
    try {
      await hooked(() => lockStandingChainHead(c.fx.companyId, inv.je),
        (t) => t.includes('SELECT status, reversed_at FROM gl_journal_entries') && t.includes('FOR UPDATE'), 1,
        async () => {
          await holder.query('BEGIN');
          await holder.query('SELECT id FROM gl_journal_entries WHERE id = $1 FOR UPDATE', [r2]);
        }).catch((e: unknown) => { err = e; });
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }
    const ms = Date.now() - started;
    expect(err, String(err)).toBeInstanceOf(JournalReversalLockTimeoutError);
    expect(ms).toBeGreaterThan(4000);
    expect(ms, 'a per-pass budget waits ~3 s + 5 s').toBeLessThan(6500);
  }, 30000);

  it('HTTP void: two reversals landing after the leg read move the head (still standing) — retryable, nothing booked', async () => {
    const bill = await postedBill(c);
    const pay = await processedPayment(c, bill.id, 300);
    const t0 = await tb(c);
    let err: unknown = null;
    await hooked(() => voidSupplierPayment(c.fx.companyId, pay.id, c.fx.userId),
      (t) => t.includes('FROM supplier_payments') && t.includes('FOR UPDATE'), 1,
      async () => { await buildChain(c, pay.je, 2); }).catch((e: unknown) => { err = e; });
    expect(err, String(err)).toBeInstanceOf(SupplierPaymentRefusal);
    expect((err as SupplierPaymentRefusal).retryable).toBe(true);
    expect((await one(sql`SELECT status FROM supplier_payments WHERE id = ${pay.id}::UUID`)).status).toBe('processed');
    expect(diff(t0, await tb(c))).toMatchObject({ ap: 0, bank: 0 }); // the two GL reversals net out
  }, 30000);

  it('receipt cancel: a receipt confirmed between the peek and the lock is refused, not cancelled with its journal standing', async () => {
    const inv = await postedInvoice(c);
    const draft = await inTx(c.fx, () => createCustomerPayment(c.fx.companyId, {
      clientId: c.fx.customerId, paymentDate: '2026-05-20', totalAmount: 250, paymentMethod: 'eft',
      bankAccountId: c.fx.bankAccountId, allocations: [{ invoiceId: inv.id, amount: 250 }],
    }, c.fx.userId));
    let err: unknown = null;
    await hooked(() => cancelCustomerPayment(c.fx.companyId, draft.id, c.fx.userId),
      (t) => t.includes('SELECT payment_number, status, gl_journal_entry_id FROM customer_payments'), 1,
      async () => { await inTx(c.fx, () => confirmCustomerPayment(c.fx.companyId, draft.id, c.fx.userId)); })
      .catch((e: unknown) => { err = e; });
    expect(err, String(err)).toBeInstanceOf(SupplierPaymentRefusal);
    expect((err as SupplierPaymentRefusal).retryable).toBe(true);
    const p = await one(sql`SELECT status, gl_journal_entry_id FROM customer_payments WHERE id = ${draft.id}::UUID`);
    expect(p.status).toBe('confirmed');
    expect((await one(sql`SELECT reversed_at FROM gl_journal_entries WHERE id = ${String(p.gl_journal_entry_id)}::UUID`)).reversed_at)
      .toBeNull();
  }, 30000);

  it('the journals lock takes its rows in id order, whatever order the scan finds them in', async () => {
    // A chain whose physically-first journal X has the HIGHER id than its head R2, so a seq scan without
    // ORDER BY would lock X first.
    let x = '', r2 = '';
    for (let i = 0; i < 30 && !x; i++) {
      const bill = await postedBill(c);
      const pay = await processedPayment(c, bill.id, 100);
      const ch = await buildChain(c, pay.je, 2);
      const rows = (await sql`SELECT id::TEXT AS id FROM gl_journal_entries
        WHERE id = ANY(${[ch[0]!, ch[2]!]}::UUID[]) ORDER BY ctid`) as Row[];
      if (String(rows[0]!.id) === ch[0] && ch[0]! > ch[2]!) { x = ch[0]!; r2 = ch[2]!; }
    }
    expect(x, 'a chain with the right physical order').not.toBe('');
    const holder = await c.fx.pool.connect();
    await holder.query('BEGIN');
    await holder.query('SELECT id FROM gl_journal_entries WHERE id = $1 FOR UPDATE', [x]); // the higher id
    let probe = '';
    const leg = { alreadyReversed: false, reverseId: r2, bankLineIds: [], seenLineIds: [], allocatedLineIds: [] };
    const flow = hooked(() => lockJournalAndUnmatch(c.fx.companyId, x, leg, 'P'), never, 0, async () => undefined,
      async (cl) => { await cl.query('SET LOCAL enable_indexscan = off; SET LOCAL enable_bitmapscan = off; SET LOCAL enable_indexonlyscan = off'); })
      .catch(() => undefined);
    await sleep(800); // the flow is now waiting on X
    const p = await c.fx.pool.connect();
    try {
      await p.query('BEGIN');
      await p.query('SELECT id FROM gl_journal_entries WHERE id = $1 FOR UPDATE NOWAIT', [r2]);
      probe = 'free';
    } catch (e) {
      probe = String((e as { code?: string }).code);
    } finally {
      await p.query('ROLLBACK');
      p.release();
      await holder.query('ROLLBACK');
      holder.release();
    }
    await flow;
    expect(probe, 'R2 (the lower id) is locked before the wait on X').toBe('55P03');
  }, 60000);
});
