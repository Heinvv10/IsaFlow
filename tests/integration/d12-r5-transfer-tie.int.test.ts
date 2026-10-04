/**
 * D12 round 5 (brk-d12 round 4 on fd7302920): a STALE transfer tie is not a transfer's cash.
 * Nothing clears `transfer_journal_entry_id` when a line is unwound (register item), so a line tied to transfer T
 * through bank-match-confirm's `bank_transfer` arm and then unmatched keeps T's id for ever. Round 3 counted that id in
 * `findChainCashLines`; round 5 drops the arm — every LIVE transfer tie also carries a matched line of T.
 *  R4-0  the stale shape (imported, no matched line, T's id) is not in T's cash set;
 *  R4-1  that line later reconciled to an UNRELATED journal on a completed session no longer refuses the transfer's
 *        reversal — bank reverse of the transfer's own line, and the journal route on T (was 409);
 *  R4-2  auto_match (head of T, then the stale line) racing the reversal gate (line, then head): no 40P01;
 *  LIVE  a line tied to T through the confirm arm and reconciled on a completed session still refuses T's reversal (409)
 *        — through its matched line.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { sql } from '@/lib/neon';
import journalEntriesAction from '../../pages/api/accounting/journal-entries-action';
import bankMatchConfirm from '../../pages/api/accounting/bank-match-confirm';
import { reverseJournalEntry } from '@/modules/accounting/services/gl/journalEntryService';
import { refuseJournalCashOfCompletedReconciliation } from '@/modules/accounting/services/bank/reconciledCash';
import { findChainCashLines } from '@/modules/accounting/services/bank/chainBankLines';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { inTx, runOn } from './helpers/l1FifoFixture';
import { teardown, type Ctx } from './d8-r4-helpers';
import { clearExtras, setupWithUser } from './d10-helpers';
import { call, cleanup, matchInto, newBank, routes, seedJournal, startSession, type Route } from './d12-helpers';

let c: Ctx;
let token = '';
type Row = Record<string, unknown>;
const REFUSAL = /is completed — reopen it first/;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const deadlocks = async () => Number(((await sql`SELECT deadlocks FROM pg_stat_database
  WHERE datname = current_database()`) as Row[])[0]!.deadlocks);
const reverse = (id: string) => call(c, token, journalEntriesAction as Route, { id, action: 'reverse' });
const insLine = async (id: string, bank: string, amount: number, date: string) => {
  await sql`INSERT INTO bank_transactions (id, company_id, bank_account_id, transaction_date, amount, description, status)
    VALUES (${id}::UUID, ${c.fx.companyId}::UUID, ${bank}::UUID, ${date}::DATE, ${amount}, ${`d12 r5 ${id.slice(-4)}`}, 'imported')`;
  return id;
};
const tie = async (id: string) => ((await sql`SELECT status, transfer_journal_entry_id::TEXT AS t,
  matched_journal_line_id::TEXT AS jl FROM bank_transactions WHERE id = ${id}::UUID`) as Row[])[0]!;

/** A transfer A -> B (allocate SA); LB on B confirmed against T's B leg (bank_transfer arm), optionally unmatched. */
async function transferTie(opts: { unmatch: boolean; lbId?: string; lbAmount?: number }) {
  const bankA = await newBank(c);
  const bankB = await newBank(c);
  const sa = await insLine(randomUUID(), bankA, -100, '2026-06-05');
  const al = await call(c, token, routes.tx, { action: 'allocate', bankTransactionId: sa, allocationType: 'transfer', contraAccountId: bankB });
  expect(al.status, al.body).toBe(200);
  const t = String((await tie(sa)).t);
  const tLegB = String(((await sql`SELECT id FROM gl_journal_lines WHERE journal_entry_id = ${t}::UUID
    AND gl_account_id = ${bankB}::UUID`) as Row[])[0]!.id);
  const lb = await insLine(opts.lbId ?? randomUUID(), bankB, opts.lbAmount ?? 100, '2026-06-06');
  const conf = await call(c, token, bankMatchConfirm as Route, { bankTransactionId: lb, candidateType: 'bank_transfer', candidateId: tLegB });
  expect(conf.status, conf.body).toBe(200);
  if (opts.unmatch) expect((await call(c, token, routes.tx, { action: 'unmatch', bankTransactionId: lb })).status).toBe(200);
  return { bankA, bankB, sa, t, tLegB, lb };
}

/** The stale line then matched to an UNRELATED journal J on bank B, reconciled on a completed session. */
async function staleReconciledElsewhere() {
  const s = await transferTie({ unmatch: true });
  const j = await seedJournal(c, s.bankB, 55, '2026-06-07');
  await sql`UPDATE bank_transactions SET amount = -55 WHERE id = ${s.lb}::UUID`;
  const rec = await startSession(c, token, s.bankB);
  await matchInto(c, token, rec, { bt: s.lb, jl: j });
  expect((await call(c, token, routes.recon, { action: 'complete', reconciliationId: rec })).status).toBe(200);
  expect(await tie(s.lb)).toMatchObject({ status: 'reconciled', t: s.t, jl: j });
  return s;
}

describe.skipIf(!process.env.DATABASE_URL || !process.env.JWT_SECRET)('D12 round 5: a stale transfer tie is not cash', () => {
  beforeAll(async () => {
    assertNotProductionDb('D12 r5');
    ({ c, token } = await setupWithUser('D12T5'));
  }, 120000);
  afterAll(async () => { await cleanup(c); await clearExtras(c); await teardown(c); }, 120000);

  it('R4-0 the stale shape exists after unmatch, and it is not in the transfer\'s cash set', async () => {
    const s = await transferTie({ unmatch: true });
    expect(await tie(s.lb), 'the pre-existing stale metadata (register)').toMatchObject({ status: 'imported', jl: null, t: s.t });
    expect(await inTx(c.fx, () => findChainCashLines(c.fx.companyId, s.t))).toEqual([s.sa.toLowerCase()]);
  }, 60000);

  it('R4-1 bank reverse of the transfer\'s own line, with the stale line reconciled ELSEWHERE -> 200', async () => {
    const s = await staleReconciledElsewhere();
    const out = await call(c, token, routes.tx, { action: 'reverse', bankTransactionId: s.sa });
    expect(out.status, out.body).toBe(200);
    expect((await tie(s.lb)).status, 'the other session\'s line is untouched').toBe('reconciled');
  }, 60000);

  it('R4-1 journal-entries-action reverse of T, same shape -> 200', async () => {
    const s = await staleReconciledElsewhere();
    const out = await reverse(s.t);
    expect(out.status, out.body).toBe(200);
  }, 60000);

  it('R4-2 auto_match (T\'s head, then the stale line) racing the reversal gate (line, then head): no 40P01', async () => {
    const s = await transferTie({ unmatch: true, lbId: `ffffffff-ffff-4fff-bfff-${randomUUID().slice(-12)}`, lbAmount: -77 });
    await insLine(`00000000-0000-4000-8000-${randomUUID().slice(-12)}`, s.bankB, -100, '2026-06-05');
    await seedJournal(c, s.bankB, 77, '2026-06-06');
    const dl0 = await deadlocks();
    const cl: PoolClient = await c.fx.pool.connect();
    await cl.query('BEGIN');
    const locked = await runOn(c.fx, cl, () => refuseJournalCashOfCompletedReconciliation(c.fx.companyId, s.t));
    const pM = call(c, token, routes.tx, { action: 'auto_match', bankAccountId: s.bankB });
    await sleep(400);
    let aErr: unknown = null;
    try { await runOn(c.fx, cl, () => reverseJournalEntry(c.fx.companyId, s.t, c.fx.userId, { cashLinesLocked: locked })); }
    catch (e) { aErr = e; }
    await cl.query('ROLLBACK').catch(() => undefined);
    cl.release();
    const m = await pM;
    await sleep(1500);
    expect(await deadlocks() - dl0, 'Postgres detected a deadlock').toBe(0);
    expect(locked, 'the gate holds only the transfer\'s own line').toEqual([s.sa.toLowerCase()]);
    expect(m.status, m.body).toBe(200);
    expect(m.body).not.toMatch(/"skippedRaced":[1-9]/);
    // The reversal met the match auto_match made meanwhile on T (outside its locked set): a typed retry, or it passed.
    if (aErr) expect((aErr as { code?: string }).code, String(aErr)).toMatch(/LOCK_TIMEOUT$/);
  }, 60000);

  it('LIVE a line tied to T through the confirm arm and reconciled on a completed session still refuses T (409)', async () => {
    const s = await transferTie({ unmatch: false });
    const rec = await startSession(c, token, s.bankB);
    await matchInto(c, token, rec, { bt: s.lb, jl: s.tLegB });
    expect((await call(c, token, routes.recon, { action: 'complete', reconciliationId: rec })).status).toBe(200);
    const out = await reverse(s.t);
    expect(out.status, out.body).toBe(409);
    expect(out.body).toMatch(REFUSAL);
  }, 60000);
});
