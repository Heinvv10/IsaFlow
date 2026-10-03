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
import bankTransactionsAction from '../../pages/api/accounting/bank-transactions-action';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { inTx } from './helpers/l1FifoFixture';
import { diff, tb, teardown, type Ctx } from './d8-r4-helpers';
import {
  AMOUNT, callRoute, chainDoc, clearExtras, docState, expectOut, setupWithUser, type Handler, type Side,
} from './d10-helpers';

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
});
