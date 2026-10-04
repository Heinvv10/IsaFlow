/**
 * D12 round 4 (brk-d12 R3-1 on ca365c65e): a writer that ties a statement line to an EXISTING journal takes FOR SHARE
 * on the chain's standing HEAD — the entry a reversal claims — and re-reads the chain under it.
 *  R3-1  X <- R1 <- R2 (X back in the ledger); A reverses the head R2 and holds it uncommitted (gate passed, re-check
 *        passed, contra posted); B matches a line to X's bank leg INTO a session. On ca365c65e B matched at once (it held
 *        only X), completed the session, A committed: signed-off cash gone. Now B waits, then refuses (X is out).
 *  HELD  the head held by a peer: the match answers 503 + Retry-After at ~5 s.
 *  DEEP  X <- R1 <- R2 <- R3: X (three contras) and R2 (reversed by R3) are out — a match to either is refused.
 *  TR    the transfer RELINK (bank-relink-transfers): a reversal of the transfer journal in flight; the relink waits on
 *        the head and does not tie the counterparty line to a journal that left the ledger.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { sql } from '@/lib/neon';
import journalEntriesAction from '../../pages/api/accounting/journal-entries-action';
import bankRelinkTransfers from '../../pages/api/accounting/bank-relink-transfers';
import { reverseJournalEntry } from '@/modules/accounting/services/gl/journalEntryService';
import { refuseJournalCashOfCompletedReconciliation } from '@/modules/accounting/services/bank/reconciledCash';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { teardown, type Ctx } from './d8-r4-helpers';
import { clearExtras, setupWithUser } from './d10-helpers';
import {
  call, cleanup, completedInvariant, heldWork, lineOf, newBank, routes, seedLine, seedPair, settledWithin,
  startSession, type Call, type Route,
} from './d12-helpers';

let c: Ctx;
let token = '';
type Row = Record<string, unknown>;
const reverse = (id: string) => call(c, token, journalEntriesAction as Route, { id, action: 'reverse' });
const idOf = (o: Call) => String((o.data as { id: string }).id);
const bankLeg = async (je: string, bank: string) => String(((await sql`SELECT id FROM gl_journal_lines
  WHERE journal_entry_id = ${je}::UUID AND gl_account_id = ${bank}::UUID LIMIT 1`) as Row[])[0]!.id);
/** A's reversal of `je` exactly as the journal route runs it, held uncommitted. */
const heldReversal = (je: string) => heldWork(c, async () => reverseJournalEntry(c.fx.companyId, je, c.fx.userId, {
  cashLinesLocked: await refuseJournalCashOfCompletedReconciliation(c.fx.companyId, je) }));

describe.skipIf(!process.env.DATABASE_URL || !process.env.JWT_SECRET)('D12 round 4: tie writers hold the chain head', () => {
  beforeAll(async () => {
    assertNotProductionDb('D12 r4');
    ({ c, token } = await setupWithUser('D12H4'));
  }, 120000);
  afterAll(async () => { await cleanup(c); await clearExtras(c); await teardown(c); }, 120000);

  it('R3-1 the head R2 is being reversed (held); a match to the ROOT X waits, then is refused; nothing signed off', async () => {
    const bank = await newBank(c);
    const p = await seedPair(c, bank, 181.81, '2026-06-03');
    const r2 = idOf(await reverse(idOf(await reverse(p.je))));
    const rec = await startSession(c, token, bank);
    const a = await heldReversal(r2);
    expect(a.error, String(a.error)).toBeNull();
    const pm = call(c, token, routes.tx, { action: 'match', bankTransactionId: p.bt, journalLineId: p.jl, reconciliationId: rec });
    const early = await settledWithin(pm, 1500);
    await a.commit();
    const m = await pm;
    expect(early, 'the match waited on the chain head').toBe(false);
    expect(m.status, m.body).toBe(400);
    expect(m.body).toMatch(/reversed/i);
    expect(await lineOf(p.bt)).toMatchObject({ status: 'imported', jl: null });
    await call(c, token, routes.recon, { action: 'complete', reconciliationId: rec });
    expect(await completedInvariant(c, bank, rec, true)).toBeNull();
  }, 60000);

  it('HELD a chain head held by a peer: the match answers 503 + Retry-After at ~5 s, the line untouched', async () => {
    const bank = await newBank(c);
    const p = await seedPair(c, bank, 182.82, '2026-06-03');
    const r2 = idOf(await reverse(idOf(await reverse(p.je))));
    const h: PoolClient = await c.fx.pool.connect();
    await h.query('BEGIN');
    await h.query('SELECT id FROM gl_journal_entries WHERE id = $1 FOR UPDATE', [r2]);
    let out: Call;
    try { out = await call(c, token, routes.tx, { action: 'match', bankTransactionId: p.bt, journalLineId: p.jl }); }
    finally { await h.query('ROLLBACK'); h.release(); }
    expect(out.status, out.body).toBe(503);
    expect(out.retryAfter).toBe('2');
    expect(out.ms).toBeGreaterThan(4000); expect(out.ms).toBeLessThan(8500);
    expect((await lineOf(p.bt)).status).toBe('imported');
  }, 60000);

  it('DEEP X <- R1 <- R2 <- R3: a match to X, or to R2, is refused (both out of the ledger)', async () => {
    const bank = await newBank(c);
    const p = await seedPair(c, bank, 183.83, '2026-06-03');
    const r1 = idOf(await reverse(p.je));
    const r2 = idOf(await reverse(r1));
    expect((await reverse(r2)).status).toBe(200);
    for (const jl of [p.jl, await bankLeg(r2, bank)]) {
      const out = await call(c, token, routes.tx, { action: 'match', bankTransactionId: p.bt, journalLineId: jl });
      expect(out.status, out.body).toBe(400);
      expect(out.body).toMatch(/reversed/i);
    }
    expect((await lineOf(p.bt)).status).toBe('imported');
  }, 60000);

  it('TR a transfer relink while the transfer journal is being reversed: waits, then does not link to it', async () => {
    const bankA = await newBank(c);
    const bankB = await newBank(c);
    const lineA = await seedLine(c, bankA, 60, '2026-06-08');
    const alloc = await call(c, token, routes.tx, { action: 'allocate', bankTransactionId: lineA, allocationType: 'transfer',
      contraAccountId: bankB });
    expect(alloc.status, alloc.body).toBe(200);
    const t = String(((await sql`SELECT transfer_journal_entry_id AS t FROM bank_transactions WHERE id = ${lineA}::UUID`) as Row[])[0]!.t);
    const [lb] = (await sql`INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date, amount, description, status)
      VALUES (${c.fx.companyId}::UUID, ${bankB}::UUID, '2026-06-08', 60, 'D12 r4 counterpart', 'imported') RETURNING id`) as Row[];
    const lineB = String(lb!.id);
    const a = await heldReversal(t);
    expect(a.error, String(a.error)).toBeNull();
    const pr = call(c, token, bankRelinkTransfers as Route, { bankAccountId: bankB });
    const early = await settledWithin(pr, 1500);
    await a.commit();
    const r = await pr;
    expect(early, 'the relink waited on the transfer journal').toBe(false);
    expect(r.status, r.body).toBe(200);
    expect(await lineOf(lineB)).toMatchObject({ status: 'imported', jl: null });
  }, 60000);

  it('TR control: with no reversal in flight the relink still links the counterpart', async () => {
    const bankA = await newBank(c);
    const bankB = await newBank(c);
    const lineA = await seedLine(c, bankA, 70, '2026-06-09');
    expect((await call(c, token, routes.tx, { action: 'allocate', bankTransactionId: lineA, allocationType: 'transfer',
      contraAccountId: bankB })).status).toBe(200);
    const [lb] = (await sql`INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date, amount, description, status)
      VALUES (${c.fx.companyId}::UUID, ${bankB}::UUID, '2026-06-09', 70, 'D12 r4 counterpart ok', 'imported') RETURNING id`) as Row[];
    const r = await call(c, token, bankRelinkTransfers as Route, { bankAccountId: bankB });
    expect(r.body).toMatch(/"linked":1/);
    expect((await lineOf(String(lb!.id))).status).toBe('allocated');
  }, 60000);
});
