/**
 * D12 interleavings: the session row serialises completion / reopen against every line writer. Connection B does its
 * work and holds it uncommitted (its locks held); the route runs on A.
 *  · completion first -> the writer WAITS for it, then is refused 409 (match, auto_match, unmatch, reverse). On
 *    ddc4dd355 the match and auto_match never waited (the line was matched into the signed-off session), the unmatch
 *    waited on the line and then unmatched the reconciled line, the reverse answered 400.
 *  · writer first -> the completion WAITS, then signs off the figures the writer left: a line matched meanwhile is
 *    reconciled, a reversal's contra is in the recomputed GL (which then refuses the sign-off). On ddc4dd355 the
 *    completion did not wait: it signed off without the line, or with a GL figure the ledger no longer had.
 *  · reopen waits for a writer holding the session; a held session row is 503 + Retry-After at ~5 s; no 40P01.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { completeReconciliation } from '@/modules/accounting/services/bank/bankReconciliationService';
import { reopenReconciliation } from '@/modules/accounting/services/bank/bankReconciliationReopenService';
import { startReconciliation } from '@/modules/accounting/services/bank/bankReconciliationService';
import { autoMatchTransactions } from '@/modules/accounting/services/bank/bankAutoMatchService';
import { matchTransaction, unmatchTransaction } from '@/modules/accounting/services/bank/bankTxStatusMutations';
import { reverseReconciledTransaction } from '@/modules/accounting/services/bank/bankAllocationService';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { teardown, type Ctx } from './d8-r4-helpers';
import { clearExtras, setupWithUser } from './d10-helpers';
import {
  call, cleanup, completedInvariant, heldWork, holdSession, lineOf, matchInto, newBank, routes, seedLine, seedPair,
  settledWithin, startSession, type Call,
} from './d12-helpers';

let c: Ctx;
let token = '';
const REFUSAL = /is completed — reopen it first/;
const NO_DEADLOCK = (o: Call) => { expect(o.status, o.body).not.toBe(500); expect(o.body).not.toMatch(/deadlock|40P01/i); };
const header = async (rec: string): Promise<string> => (await c.fx.pool.query('SELECT status FROM bank_reconciliations WHERE id = $1', [rec])).rows[0]!.status;

/** An in-progress session on its own account: `m` matched into it, `f` claimed by it and still open. */
async function scenario() {
  const bank = await newBank(c);
  const m = await seedPair(c, bank, 101.01, '2026-06-02');
  const f = await seedPair(c, bank, 202.02, '2026-06-03');
  const rec = await startSession(c, token, bank);
  await matchInto(c, token, rec, m);
  return { bank, rec, m, f };
}

/** B does `work` and holds it; A runs `route`; A must still be waiting after 1.5 s; B commits; A's answer. */
async function bFirst(work: () => Promise<unknown>, a: () => Promise<Call>) {
  const b = await heldWork(c, work);
  expect(b.error, String(b.error)).toBeNull();
  const pending = a();
  const early = await settledWithin(pending, 1500);
  await b.commit();
  const out = await pending;
  NO_DEADLOCK(out);
  return { early, out };
}

describe.skipIf(!process.env.DATABASE_URL || !process.env.JWT_SECRET)('D12 races: completion and reopen vs line writers', () => {
  beforeAll(async () => {
    assertNotProductionDb('D12 races');
    ({ c, token } = await setupWithUser('D12R'));
  }, 120000);
  afterAll(async () => { await cleanup(c); await clearExtras(c); await teardown(c); }, 120000);

  const complete = (rec: string) => () => completeReconciliation(c.fx.companyId, rec, c.fx.userId);

  it('completion first, then match INTO it: the match waits, then 409; nothing added', async () => {
    const s = await scenario();
    const { early, out } = await bFirst(complete(s.rec), () => call(c, token, routes.tx,
      { action: 'match', bankTransactionId: s.f.bt, journalLineId: s.f.jl, reconciliationId: s.rec }));
    expect(early, 'the match waited for the completion').toBe(false);
    expect(out.status, out.body).toBe(409);
    expect(out.body).toMatch(REFUSAL);
    expect((await lineOf(s.f.bt)).status).toBe('imported');
    expect(await completedInvariant(c, s.bank, s.rec, true)).toBeNull();
  }, 60000);

  it('completion first, then auto_match INTO it: waits, then 409; nothing matched', async () => {
    const s = await scenario();
    const { early, out } = await bFirst(complete(s.rec), () => call(c, token, routes.tx,
      { action: 'auto_match', bankAccountId: s.bank, reconciliationId: s.rec }));
    expect(early).toBe(false);
    expect(out.status, out.body).toBe(409);
    expect((await lineOf(s.f.bt)).status).toBe('imported');
    expect(await completedInvariant(c, s.bank, s.rec, true)).toBeNull();
  }, 60000);

  it('completion first, then unmatch of a line it reconciles: waits, then 409; the line stays reconciled', async () => {
    const s = await scenario();
    const { early, out } = await bFirst(complete(s.rec), () => call(c, token, routes.tx,
      { action: 'unmatch', bankTransactionId: s.m.bt }));
    expect(early).toBe(false);
    expect(out.status, out.body).toBe(409);
    expect((await lineOf(s.m.bt)).status).toBe('reconciled');
  }, 60000);

  it('completion first, then reverse of a line it reconciles: waits, then 409; no contra', async () => {
    const s = await scenario();
    const { early, out } = await bFirst(complete(s.rec), () => call(c, token, routes.tx,
      { action: 'reverse', bankTransactionId: s.m.bt }));
    expect(early).toBe(false);
    expect(out.status, out.body).toBe(409);
    expect((await lineOf(s.m.bt)).status).toBe('reconciled');
    expect(await completedInvariant(c, s.bank, s.rec, true)).toBeNull();
  }, 60000);

  it('match first (held): the completion waits, then reconciles that line too', async () => {
    const s = await scenario();
    const { early, out } = await bFirst(() => matchTransaction(c.fx.companyId, s.f.bt, s.f.jl, s.rec),
      () => call(c, token, routes.recon, { action: 'complete', reconciliationId: s.rec }));
    expect(early, 'the completion waited for the match').toBe(false);
    expect(out.status, out.body).toBe(200);
    expect((await lineOf(s.f.bt)).status).toBe('reconciled');
    expect(await completedInvariant(c, s.bank, s.rec, true)).toBeNull();
  }, 60000);

  it('auto_match first (held): the completion waits, then reconciles what it matched', async () => {
    const s = await scenario();
    const { early, out } = await bFirst(() => autoMatchTransactions(c.fx.companyId, s.bank, s.rec),
      () => call(c, token, routes.recon, { action: 'complete', reconciliationId: s.rec }));
    expect(early).toBe(false);
    expect(out.status, out.body).toBe(200);
    expect((await lineOf(s.f.bt)).status).toBe('reconciled');
    expect(await completedInvariant(c, s.bank, s.rec, true)).toBeNull();
  }, 60000);

  it('unmatch first (held): the completion waits, then leaves that line out', async () => {
    const s = await scenario();
    const { early, out } = await bFirst(() => unmatchTransaction(c.fx.companyId, s.m.bt),
      () => call(c, token, routes.recon, { action: 'complete', reconciliationId: s.rec }));
    expect(early).toBe(false);
    expect(out.status, out.body).toBe(200);
    expect((await lineOf(s.m.bt)).status).toBe('imported');
    expect(await completedInvariant(c, s.bank, s.rec, true)).toBeNull();
  }, 60000);

  it('reversal of an allocated line first (held): the completion waits, recomputes, and refuses the moved GL', async () => {
    const bank = await newBank(c);
    const line = await seedLine(c, bank, 150, '2026-06-05');
    const alloc = await call(c, token, routes.tx,
      { action: 'allocate', bankTransactionId: line, allocationType: 'account', contraAccountId: c.acct.expense });
    expect(alloc.status, alloc.body).toBe(200);
    const rec = await startSession(c, token, bank);
    expect(await lineOf(line)).toMatchObject({ status: 'allocated', rec });
    const { early, out } = await bFirst(() => reverseReconciledTransaction(c.fx.companyId, line, c.fx.userId),
      () => call(c, token, routes.recon, { action: 'complete', reconciliationId: rec }));
    expect(early).toBe(false);
    expect(out.status, out.body).toBe(400);
    expect(out.body).toMatch(/difference/);
    expect(await header(rec)).toBe('in_progress');
    expect(await completedInvariant(c, bank, rec, true)).toBeNull();
  }, 60000);

  it('reopen waits for a line writer holding the session, then reopens', async () => {
    const s = await scenario();
    await call(c, token, routes.recon, { action: 'complete', reconciliationId: s.rec });
    const release = await holdSession(c, s.rec, 'SHARE', 2500);
    const out = await call(c, token, routes.recon, { action: 'reopen', reconciliationId: s.rec, reason: 'd12 race' });
    await release();
    NO_DEADLOCK(out);
    expect(out.status, out.body).toBe(200);
    expect(out.ms, 'it waited for the holder').toBeGreaterThan(2000);
  }, 60000);

  it('reopen first (held): an unmatch waits, then works on the reopened session', async () => {
    const s = await scenario();
    await call(c, token, routes.recon, { action: 'complete', reconciliationId: s.rec });
    const { early, out } = await bFirst(() => reopenReconciliation(c.fx.companyId, s.rec, c.fx.userId, { reason: 'd12' }),
      () => call(c, token, routes.tx, { action: 'unmatch', bankTransactionId: s.m.bt }));
    expect(early).toBe(false);
    expect(out.status, out.body).toBe(200);
    expect((await lineOf(s.m.bt)).status).toBe('imported');
  }, 60000);

  it('a held session row: unmatch on it -> 503 + Retry-After at ~5 s, nothing written', async () => {
    const s = await scenario();
    await call(c, token, routes.recon, { action: 'complete', reconciliationId: s.rec });
    const release = await holdSession(c, s.rec, 'UPDATE');
    let out: Call;
    try { out = await call(c, token, routes.tx, { action: 'unmatch', bankTransactionId: s.m.bt }); } finally { await release(); }
    expect(out.status, out.body).toBe(503);
    expect(out.retryAfter).toBe('2');
    expect(out.ms).toBeGreaterThan(4000); expect(out.ms).toBeLessThan(8500);
    expect((await lineOf(s.m.bt)).status).toBe('reconciled');
  }, 60000);

  it('a held session row: complete -> 503 + Retry-After at ~5 s, still in progress', async () => {
    const s = await scenario();
    const release = await holdSession(c, s.rec, 'SHARE');
    let out: Call;
    try { out = await call(c, token, routes.recon, { action: 'complete', reconciliationId: s.rec }); } finally { await release(); }
    expect(out.status, out.body).toBe(503);
    expect(out.retryAfter).toBe('2');
    expect(out.ms).toBeGreaterThan(4000); expect(out.ms).toBeLessThan(8500);
    expect(await header(s.rec)).toBe('in_progress');
  }, 60000);

  it('a held session row: reopen -> 503 + Retry-After at ~5 s, still completed', async () => {
    const s = await scenario();
    await call(c, token, routes.recon, { action: 'complete', reconciliationId: s.rec });
    const release = await holdSession(c, s.rec, 'SHARE');
    let out: Call;
    try { out = await call(c, token, routes.recon, { action: 'reopen', reconciliationId: s.rec, reason: 'd12' }); } finally { await release(); }
    expect(out.status, out.body).toBe(503);
    expect(out.ms).toBeGreaterThan(4000); expect(out.ms).toBeLessThan(8500);
    expect(await header(s.rec)).toBe('completed');
  }, 60000);

  it('a stamp that moves while the writer waits on the line (start claims it) -> 503 retry, then the retry works', async () => {
    const bank = await newBank(c);
    const line = await seedLine(c, bank, 404.04, '2026-06-06');
    const { early, out } = await bFirst(() => startReconciliation(c.fx.companyId, bank, '2026-06-30', 0, c.fx.userId),
      () => call(c, token, routes.tx, { action: 'exclude', bankTransactionId: line, excludeReason: 'd12' }));
    expect(early, 'the exclude waited on the line the start claimed').toBe(false);
    expect(out.status, out.body).toBe(503);
    expect(out.retryAfter).toBe('2');
    expect((await lineOf(line)).status).toBe('imported');
    const retry = await call(c, token, routes.tx, { action: 'exclude', bankTransactionId: line, excludeReason: 'd12' });
    expect(retry.status, retry.body).toBe(200);
  }, 60000);

  it('no 40P01: complete racing matches and an unmatch on the same session, five rounds', async () => {
    for (let round = 0; round < 5; round++) {
      const s = await scenario();
      const outs = await Promise.all([
        call(c, token, routes.tx, { action: 'match', bankTransactionId: s.f.bt, journalLineId: s.f.jl, reconciliationId: s.rec }),
        call(c, token, routes.recon, { action: 'complete', reconciliationId: s.rec }),
        call(c, token, routes.tx, { action: 'unmatch', bankTransactionId: s.m.bt }),
        call(c, token, routes.tx, { action: 'auto_match', bankAccountId: s.bank, reconciliationId: s.rec }),
      ]);
      for (const o of outs) NO_DEADLOCK(o);
      expect(await completedInvariant(c, s.bank, s.rec), JSON.stringify(outs.map((o) => o.status))).toBeNull();
    }
  }, 120000);
});
