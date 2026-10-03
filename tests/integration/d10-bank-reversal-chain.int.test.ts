/**
 * D10 O1 / O1b / O3 — bank reversal of a statement line matched to ANY journal of a document's reversal chain, through
 * the real route (`bank-transactions-action` reverse) and the MCP tool (`reverse_bank_allocation`).
 *
 * The document is found through the chain's ROOT, not the line's own journal. End state, whatever the position and
 * however many times the GL reversed the journal (k = 0..4): payment / receipt cancelled or batch reversed with its
 * members, the bill / invoice back to 0, ONE contra iff the chain stood (k even), and EVERY statement line of the chain
 * 'imported'. Reconciled cash anywhere in the chain, or a batch that cannot be reversed, refuses and changes nothing.
 * On master the line's own journal decided: a head line at k even posted the contra and left the document live, a
 * k-odd head line re-reversed the head (the payment came back), the batch was never reversed, other lines stayed matched.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { reverseBankAllocationTool } from '@/lib/mcp/tools/writeBankAllocate';
import { allocateTransaction } from '@/modules/accounting/services/bank/bankAllocationService';
import { unmatchTransaction } from '@/modules/accounting/services/bank/bankTxStatusMutations';
import bankTransactionsAction from '../../pages/api/accounting/bank-transactions-action';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { inTx, seedBankTx } from './helpers/l1FifoFixture';
import { buildChain, diff, postedBill, postedInvoice, tb, teardown, type Ctx } from './d8-r4-helpers';
import {
  AMOUNT, callRoute, chainDoc, chainState, clearExtras, docState, expectOut, lineOn, setupWithUser, type Handler, type Side,
} from './d10-helpers';
import { armBefore } from './d10-hook';

let c: Ctx;
let token = '';
const reverse = (bt: string) => callRoute(c, token, bankTransactionsAction as Handler, { action: 'reverse', bankTransactionId: bt });
const SIDES: Side[] = ['ap', 'ar', 'batch'];
const contraIff = (k: number, bank: number | undefined) => Math.abs(Math.abs(bank ?? 0) - (k % 2 === 0 ? AMOUNT : 0)) < 0.01;

describe.skipIf(!process.env.DATABASE_URL || !process.env.JWT_SECRET)('D10 O1/O1b/O3: bank reversal of a chain line', () => {
  beforeAll(async () => {
    assertNotProductionDb('D10 bank reversal chain');
    ({ c, token } = await setupWithUser('D10BRC'));
  }, 120000);
  afterAll(async () => { await clearExtras(c); await teardown(c); }, 120000);

  for (const side of SIDES) {
    for (const k of [0, 1, 2, 3, 4]) {
      for (let p = 0; p <= k; p++) {
        it(`${side} k=${k}: the line on chain position ${p} — document out, one contra iff k even, line free`, async () => {
          const d = await chainDoc(c, side, k, [p]);
          const t0 = await tb(c);
          const r = await reverse(d.lines.get(p)!);
          expect(r.status, r.body).toBe(200);
          expect(expectOut(await docState(c, d))).toBeNull();
          expect(contraIff(k, diff(t0, await tb(c)).bank), JSON.stringify(diff(t0, await tb(c)))).toBe(true);
        }, 60000);
      }
    }
    for (const k of [2, 3]) {
      for (const p of [0, k]) {
        it(`${side} k=${k}: lines on EVERY chain journal, the line on position ${p} reversed — every line freed (O1b)`, async () => {
          const d = await chainDoc(c, side, k, Array.from({ length: k + 1 }, (_, i) => i));
          const t0 = await tb(c);
          const r = await reverse(d.lines.get(p)!);
          expect(r.status, r.body).toBe(200);
          expect(expectOut(await docState(c, d))).toBeNull();
          expect(contraIff(k, diff(t0, await tb(c)).bank)).toBe(true);
        }, 60000);
      }
    }
    it(`${side} k=2: another chain line is RECONCILED — refused, nothing changed`, async () => {
      const d = await chainDoc(c, side, 2, [0, 1, 2]);
      await sql`UPDATE bank_transactions SET status = 'reconciled' WHERE id = ${d.lines.get(1)!}::UUID`;
      const before = await docState(c, d);
      const t0 = await tb(c);
      const r = await reverse(d.lines.get(2)!);
      expect(r.status, r.body).toBe(400);
      expect(r.body).toMatch(/reconcil/i);
      expect(await docState(c, d)).toEqual(before);
      expect(diff(t0, await tb(c)).bank).toBe(0);
    }, 60000);
  }

  it('batch k=0: a member no longer processed — the batch cannot be reversed, so the bank reversal refuses, nothing changed', async () => {
    const d = await chainDoc(c, 'batch', 0, [0]);
    await sql`UPDATE supplier_payments SET status = 'cancelled' WHERE id = ${d.payId}::UUID`;
    const before = await docState(c, d);
    const t0 = await tb(c);
    const r = await reverse(d.lines.get(0)!);
    expect(r.status, r.body).toBe(400);
    expect(r.body).toContain('the batch cannot be reversed');
    expect(await docState(c, d)).toEqual(before);
    expect(diff(t0, await tb(c)).bank).toBe(0);
  }, 60000);

  for (const side of SIDES) {
    it(`MCP reverse_bank_allocation, ${side} k=2 head line: the same end state`, async () => {
      const d = await chainDoc(c, side, 2, [2]);
      const ctx = { companyId: c.fx.companyId, userId: c.fx.userId, scopes: ['write:bank', 'write:post'], tokenJti: null, oauthAppId: null };
      const out = await inTx(c.fx, () => reverseBankAllocationTool.handler(
        { transaction_id: d.lines.get(2)!, idempotency_key: crypto.randomUUID() }, ctx as never));
      expect(out.isError ?? false, JSON.stringify(out)).toBe(false);
      expect(expectOut(await docState(c, d))).toBeNull();
    }, 60000);
  }

  // F3 (brk-d10): the ROOT line allocated (the bank allocation posted the payment / receipt) and a second line matched
  // to the head at k = 2. Reversing the head line refused "more than one allocated bank line" with exactly one; it is
  // the same document out as reversing the root line: one contra, both lines freed.
  for (const side of ['ar', 'ap'] as const) {
    for (const rev of ['head', 'root'] as const) {
      it(`${side} allocated root line + matched head line (k=2), the ${rev} line reversed — document out, both lines free`, async () => {
        const doc = side === 'ar' ? await postedInvoice(c) : await postedBill(c);
        const alloc = await seedBankTx(c.fx, { date: '2026-05-20', amount: side === 'ar' ? AMOUNT : -AMOUNT, description: `D10F3 ${++c.seq}` });
        // AR names the invoice; AP settles FIFO (the supplier's oldest open bill) — read back which bill it paid.
        const r0 = await inTx(c.fx, () => allocateTransaction(c.fx.companyId, alloc, null, c.fx.userId, 'd10', side === 'ar' ? 'customer' : 'supplier',
          side === 'ar' ? c.fx.customerId : c.fx.supplierId, undefined, undefined, undefined, undefined, side === 'ar' ? doc.id : undefined));
        const table = side === 'ar' ? 'customer_payments' : 'supplier_payments';
        const [pay] = (await c.fx.pool.query(`SELECT id FROM ${table} WHERE gl_journal_entry_id = $1`, [r0.journalEntryId])).rows;
        const [pa] = side === 'ap'
          ? (await c.fx.pool.query('SELECT invoice_id, amount_allocated FROM payment_allocations WHERE payment_id = $1', [pay.id])).rows : [];
        const paidBill = pa ? String(pa.invoice_id) : doc.id;
        const paidBefore = pa
          ? Number((await c.fx.pool.query('SELECT amount_paid FROM supplier_invoices WHERE id = $1', [paidBill])).rows[0].amount_paid) - Number(pa.amount_allocated)
          : 0;
        const ch = await buildChain(c, r0.journalEntryId, 2);
        const head = await lineOn(c, ch[2]!, side === 'ar' ? AMOUNT : -AMOUNT);
        const t0 = await tb(c);
        const r = await reverse(rev === 'head' ? head : alloc);
        expect(r.status, r.body).toBe(200);
        const [p] = (await c.fx.pool.query(`SELECT status FROM ${table} WHERE gl_journal_entry_id = $1`, [r0.journalEntryId])).rows;
        expect(p.status).toBe('cancelled');
        const docTable = side === 'ar' ? 'customer_invoices' : 'supplier_invoices';
        const paidDoc = side === 'ar' ? doc.id : paidBill;
        expect(Number((await c.fx.pool.query(`SELECT amount_paid FROM ${docTable} WHERE id = $1`, [paidDoc])).rows[0].amount_paid)).toBe(paidBefore);
        expect(await chainState(c, r0.journalEntryId)).toBe('out');
        const lines = (await c.fx.pool.query('SELECT status, matched_journal_line_id FROM bank_transactions WHERE id = ANY($1)', [[alloc, head]])).rows;
        expect(lines).toEqual([{ status: 'imported', matched_journal_line_id: null }, { status: 'imported', matched_journal_line_id: null }]);
        expect(contraIff(2, diff(t0, await tb(c)).bank)).toBe(true);
      }, 60000);
    }
  }

  // The line changed between the unlocked peek and its lock (here: unmatched by another request): a state conflict,
  // nothing written — 409, like every other "retry" race on this route.
  it('ap k=2: the head line unmatched by another request mid-reversal — 409 retry, nothing written', async () => {
    const d = await chainDoc(c, 'ap', 2, [2]);
    const before = await docState(c, d);
    const t0 = await tb(c);
    const hook = armBefore(/RECURSIVE up AS/, async () => {
      await inTx(c.fx, () => unmatchTransaction(c.fx.companyId, d.lines.get(2)!));
    });
    let r: Awaited<ReturnType<typeof reverse>>;
    try { r = await reverse(d.lines.get(2)!); } finally { hook.disarm(); }
    expect(hook.fired()).toBe(true);
    expect(r.status, r.body).toBe(409);
    expect(r.body).toMatch(/retry/);
    const after = await docState(c, d);
    expect({ ...after, lines: [] }).toEqual({ ...before, lines: [] });
    expect(diff(t0, await tb(c)).bank).toBe(0);
  }, 60000);
});
