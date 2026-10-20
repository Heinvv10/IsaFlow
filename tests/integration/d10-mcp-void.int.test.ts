/**
 * D10 O2 / O5 — the MCP void (`void_payment` / `void_receipt`, core/paymentVoidService).
 *
 * O2: `void_payment` of ONE member of a processed batch is refused, as the HTTP void refuses it ("reverse the batch"):
 *     the member carries no journal of its own, so on master it was cancelled and its bill reopened while the batch
 *     journal stood — the AP subledger R300 below the GL, and the batch could never be reversed afterwards.
 * O5: the MCP void takes the HTTP void's bank leg (`lockBankLegOf` over the chain) and its re-check under the journal
 *     lock (`lockJournalAndUnmatch`): a statement line matched to the payment's journal while the void was in flight
 *     is answered "retry" with nothing written, never left matched to a journal the void took out (on master: payment
 *     cancelled, chain out, line 'matched'). Deterministic cases first, then the interleaving hunt (every lock point).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { voidPaymentTool } from '@/lib/mcp/tools/writeVoidPayments';
import { voidPaymentDocument } from '@/modules/accounting/services/core/paymentVoidService';
import { matchTransaction } from '@/modules/accounting/services/bank/bankTxStatusMutations';
import { reverseBatch } from '@/modules/accounting/services/ap/batchPaymentReversal';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { inTx, runOn, seedBankTx } from './helpers/l1FifoFixture';
import { diff, settle, tb, teardown, type Ctx } from './d8-r4-helpers';
import { AMOUNT, bankLegOf, chainDoc, clearExtras, docState, expectOut, setupWithUser } from './d10-helpers';
import { family } from './d10-families';
import { hunt } from './d10-interleave';

let c: Ctx;
let admin: Pool;
const ctx = () => ({ companyId: c.fx.companyId, userId: c.fx.userId, scopes: ['write:invoices', 'write:post'], companyRole: 'owner', tokenJti: null, oauthAppId: null });
const textOf = (out: { content: { text: string }[] }) => out.content.map((x) => x.text).join(' ');

/** Run `fn` in a request transaction; right after the first statement matching `at` returns, run `between` to commit. */
async function pausedVoid(fn: () => Promise<unknown>, at: RegExp, between: () => Promise<unknown>) {
  const cl = await c.fx.pool.connect();
  const orig = cl.query.bind(cl) as (...a: unknown[]) => Promise<unknown>;
  let fired = false;
  (cl as unknown as { query: unknown }).query = async (...a: unknown[]) => {
    const out = await orig(...a);
    const t = typeof a[0] === 'string' ? a[0] : (a[0] as { text?: string } | undefined)?.text ?? '';
    if (!fired && at.test(t)) { fired = true; await between(); }
    return out;
  };
  await orig('BEGIN');
  try {
    const v = await runOn(c.fx, cl, fn);
    await orig('COMMIT');
    return { ok: true as const, value: v, fired };
  } catch (err) {
    await orig('ROLLBACK');
    return { ok: false as const, error: `${(err as Error).name}: ${(err as Error).message}`, fired };
  } finally {
    (cl as unknown as { query: unknown }).query = orig;
    cl.release();
  }
}

describe.skipIf(!process.env.DATABASE_URL || !process.env.JWT_SECRET)('D10 O2/O5: the MCP void', () => {
  beforeAll(async () => {
    assertNotProductionDb('D10 MCP void');
    ({ c } = await setupWithUser('D10MV'));
    admin = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  }, 120000);
  afterAll(async () => { await admin?.end(); await clearExtras(c); await teardown(c); }, 120000);

  it('O2: void_payment of a batch member is refused naming the batch; nothing changes; the batch still reverses', async () => {
    const d = await chainDoc(c, 'batch', 0, []);
    const before = await docState(c, d);
    const t0 = await tb(c);
    const out = await inTx(c.fx, () => voidPaymentTool.handler({ payment_id: d.payId, idempotency_key: crypto.randomUUID() }, ctx() as never));
    expect(out.isError, JSON.stringify(out)).toBe(true);
    expect(textOf(out as never)).toMatch(/belongs to batch .* reverse the batch/);
    expect(await docState(c, d)).toEqual(before);
    expect(diff(t0, await tb(c))).toMatchObject({ ap: 0, bank: 0 });
    await inTx(c.fx, () => reverseBatch(c.fx.companyId, d.docId, c.fx.userId));
    expect(expectOut(await docState(c, d))).toBeNull();
  }, 60000);

  for (const k of [0, 2]) {
    for (const side of ['ap', 'ar'] as const) {
      it(`O5 ${side} k=${k}: a line matched to the journal mid-void — "retry", nothing written; the retry frees it`, async () => {
        const d = await chainDoc(c, side, k, []);
        const fresh = await seedBankTx(c.fx, { date: '2026-05-20', amount: side === 'ar' ? AMOUNT : -AMOUNT, description: `D10O5 ${++c.seq}` });
        const kind = side === 'ar' ? 'customer' : 'supplier';
        const t0 = await tb(c);
        const r = await pausedVoid(() => voidPaymentDocument(c.fx.companyId, kind, d.payId, c.fx.userId),
          /FOR UPDATE/i, async () => inTx(c.fx, async () => matchTransaction(c.fx.companyId, fresh, await bankLegOf(c, d.chain[k]!))));
        expect(r.fired).toBe(true);
        expect(r.ok, JSON.stringify(r)).toBe(false);
        expect(JSON.stringify(r)).toMatch(/retry in a moment/);
        const s = await docState(c, d);
        expect(s.paid).toBe(AMOUNT);
        expect(s.chain).toBe('standing');
        expect(diff(t0, await tb(c)).bank).toBe(0);
        const again = await settle(inTx(c.fx, () => voidPaymentDocument(c.fx.companyId, kind, d.payId, c.fx.userId)));
        expect(again.ok, JSON.stringify(again)).toBe(true);
        expect(expectOut(await docState(c, d))).toBeNull();
        const [fl] = (await c.fx.pool.query('SELECT status FROM bank_transactions WHERE id = $1', [fresh])).rows;
        expect(fl.status).toBe('imported');
      }, 60000);
    }
  }

  it('O5 hunt: MCP void vs a match, and vs the HTTP void / receipt cancel, every lock point, k = 0 and 2 — 0 BAD', async () => {
    const bad = [
      ...await hunt({ fx: c.fx, admin, ks: [0, 2], pairs: [['MCPV', 'MATCH'], ['MCPV', 'HTTPV']], maxPoints: 40,
        make: (k) => family(c, 'ap', k, []) }),
      ...await hunt({ fx: c.fx, admin, ks: [0, 2], pairs: [['MCPV', 'MATCH'], ['MCPV', 'RCPT']], maxPoints: 40,
        make: (k) => family(c, 'ar', k, []) }),
    ];
    expect(bad).toEqual([]);
  }, 1_200_000);
});
