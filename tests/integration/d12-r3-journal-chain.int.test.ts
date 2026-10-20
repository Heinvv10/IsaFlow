/**
 * D12 round 3 — the journal-reversal gate (brk-d12 round 2 on 1a73a2f7b). Statement cash a COMPLETED reconciliation
 * signed off is refused (409, nothing written: the claim released, no contra) however the journal is reached:
 *  R2-1  reversing the chain HEAD (X re-reversed; the line is matched to X) — the gate now walks the whole chain;
 *  R2-2  a line tied through `provisional_je_id` (evidence-attached provisional, no matched line);
 *  (TR, a line tied only through `transfer_journal_entry_id`, was removed in round 5: that id outlives every unwind,
 *   so it is no longer counted as cash — a LIVE transfer tie is a matched line, see d12-r5-transfer-tie.)
 *  R2-3  the race: the line matched INTO the session and the session completed while the reversal's claim waited —
 *        the re-check under the claim refuses; R2-3b the same with the session still open: a line that appeared
 *        after the gate is a 503 retry, and the retry goes through;
 *  R2-4  an INTERNAL caller: the migration wizard's opening-balance re-run reverses the previous take-on journal.
 * Plus the manual evidence attach leaves a line that is no longer provisional as it is.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from '@/lib/neon';
import journalEntriesAction from '../../pages/api/accounting/journal-entries-action';
import openingBalances from '../../pages/api/accounting/migration/opening-balances';
import provisionalAttach from '../../pages/api/accounting/provisional/[jeId]/attach';
import { matchTransaction } from '@/modules/accounting/services/bank/bankTxStatusMutations';
import { completeReconciliation } from '@/modules/accounting/services/bank/bankReconciliationService';
import { reverseJournalEntryTool } from '@/lib/mcp/tools/writeJournalReverse';
import { inTx } from './helpers/l1FifoFixture';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { teardown, type Ctx } from './d8-r4-helpers';
import { clearExtras, setupWithUser } from './d10-helpers';
import {
  call, cleanup, completedInvariant, completedSession, heldWork, lineOf, matchInto, newBank, routes, seedLine, seedPair,
  settledWithin, snapshot, startSession, STATEMENT_DATE, type Route,
} from './d12-helpers';

let c: Ctx;
let token = '';
type Row = Record<string, unknown>;
const REFUSAL = /is completed — reopen it first/;
const reverse = (id: string) => call(c, token, journalEntriesAction as Route, { id, action: 'reverse' });
const reversedAt = async (je: string) => ((await sql`SELECT reversed_at FROM gl_journal_entries WHERE id = ${je}::UUID`) as Row[])[0]!.reversed_at;
const bankLeg = async (je: string, bank: string) => String(((await sql`SELECT id FROM gl_journal_lines
  WHERE journal_entry_id = ${je}::UUID AND gl_account_id = ${bank}::UUID LIMIT 1`) as Row[])[0]!.id);

/** The refusal and its "nothing written": 409, no journal added, the journal not left claimed, the session's GL true. */
async function refused(out: { status: number; body: string }, s: { bank: string; rec: string }, je: string,
  before: Awaited<ReturnType<typeof snapshot>>) {
  expect(out.status, out.body).toBe(409);
  expect(out.body).toMatch(REFUSAL);
  expect(await snapshot(c, s.bank, s.rec)).toEqual(before);
  expect(await reversedAt(je), 'the reversal claim was released').toBeNull();
  expect(await completedInvariant(c, s.bank, s.rec, true)).toBeNull();
}

async function provisionalX(bank: string, line: string, total: number) {
  const [x] = (await sql`INSERT INTO gl_journal_entries (company_id, entry_date, description, source, status, created_by,
      posting_agent, needs_evidence) VALUES (${c.fx.companyId}::UUID, '2026-06-11', 'D12 r3 provisional', 'auto_bank_recon',
      'draft', ${c.fx.userId}::UUID, 'ai-provisional:v1', true) RETURNING id`) as Row[];
  const xId = String(x!.id);
  await sql`INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit, description)
    VALUES (${c.fx.companyId}::UUID, ${xId}::UUID, ${c.acct.expense}::UUID, ${total}, 0, 'p'),
           (${c.fx.companyId}::UUID, ${xId}::UUID, ${bank}::UUID, 0, ${total}, 'p')`;
  await sql`UPDATE gl_journal_entries SET status = 'posted', posted_at = NOW() WHERE id = ${xId}::UUID`;
  await sql`UPDATE bank_transactions SET status = 'provisional', provisional_je_id = ${xId}::UUID WHERE id = ${line}::UUID`;
  return xId;
}
async function newDoc(): Promise<string> {
  const id = randomUUID();
  await sql`INSERT INTO captured_documents (id, company_id, file_name, file_type, document_type, extracted_data, status)
    VALUES (${id}::UUID, ${c.fx.companyId}::UUID, ${`d12r3-${id}.pdf`}, 'application/pdf', 'invoice', '{}'::jsonb, 'pending')`;
  return id;
}

describe.skipIf(!process.env.DATABASE_URL || !process.env.JWT_SECRET)('D12 round 3: the journal-reversal gate', () => {
  beforeAll(async () => {
    assertNotProductionDb('D12 r3');
    ({ c, token } = await setupWithUser('D12J'));
  }, 120000);
  afterAll(async () => {
    await sql`UPDATE bank_transactions SET provisional_je_id = NULL WHERE company_id = ${c.fx.companyId}::UUID`;
    await sql`DELETE FROM migration_sessions WHERE company_id = ${c.fx.companyId}::UUID`;
    await cleanup(c); await clearExtras(c); await teardown(c);
  }, 120000);

  it('R2-1 reversing the chain HEAD of a journal a completed reconciliation holds -> 409, nothing written', async () => {
    const bank = await newBank(c);
    const p = await seedPair(c, bank, 181.81, '2026-06-03');
    const r1 = await reverse(p.je);
    const r2 = await reverse(String((r1.data as { id: string }).id));
    expect(r2.status, r2.body).toBe(200);
    const head = String((r2.data as { id: string }).id);
    const rec = await startSession(c, token, bank);
    await matchInto(c, token, rec, p);
    expect((await call(c, token, routes.recon, { action: 'complete', reconciliationId: rec })).status).toBe(200);
    const before = await snapshot(c, bank, rec);
    await refused(await reverse(head), { bank, rec }, head, before);
  }, 60000);

  it('R2-2 a line tied through provisional_je_id (evidence-attached, no matched line) -> 409', async () => {
    const bank = await newBank(c);
    const line = await seedLine(c, bank, 300, '2026-06-11');
    const st = await call(c, token, routes.start, { bankAccountId: bank, statementDate: STATEMENT_DATE, statementBalance: -300 });
    const rec = String((st.data as { id: string }).id);
    const x = await provisionalX(bank, line, 300);
    const att = await call(c, token, provisionalAttach as Route, { capturedDocumentId: await newDoc() }, { jeId: x });
    expect(att.status, att.body).toBe(200);
    expect(await lineOf(line)).toMatchObject({ status: 'matched', rec, jl: null });
    expect((await call(c, token, routes.recon, { action: 'complete', reconciliationId: rec })).status).toBe(200);
    const before = await snapshot(c, bank, rec);
    await refused(await reverse(x), { bank, rec }, x, before);
  }, 60000);

  it('R2-3 matched INTO the session and completed while the reversal waited on its claim -> 409 under the claim', async () => {
    const bank = await newBank(c);
    const p = await seedPair(c, bank, 191.91, '2026-06-04');
    const rec = await startSession(c, token, bank);
    const b = await heldWork(c, async () => {
      await matchTransaction(c.fx.companyId, p.bt, p.jl, rec);
      await completeReconciliation(c.fx.companyId, rec, c.fx.userId);
    });
    expect(b.error, String(b.error)).toBeNull();
    const pending = reverse(p.je);
    const early = await settledWithin(pending, 1500);
    await b.commit();
    const before = await snapshot(c, bank, rec);
    const out = await pending;
    expect(early, 'the reversal waited on the journal').toBe(false);
    await refused(out, { bank, rec }, p.je, before);
  }, 60000);

  it('R2-3b the same with the session still open: the line appeared after the gate -> 503 retry; the retry passes', async () => {
    const bank = await newBank(c);
    const p = await seedPair(c, bank, 192.92, '2026-06-04');
    const rec = await startSession(c, token, bank);
    const b = await heldWork(c, () => matchTransaction(c.fx.companyId, p.bt, p.jl, rec));
    expect(b.error, String(b.error)).toBeNull();
    const pending = reverse(p.je);
    const early = await settledWithin(pending, 1500);
    await b.commit();
    const out = await pending;
    expect(early).toBe(false);
    expect(out.status, out.body).toBe(503);
    expect(out.retryAfter).toBe('2');
    expect(await reversedAt(p.je)).toBeNull();
    const retry = await reverse(p.je);
    expect(retry.status, retry.body).toBe(200);
  }, 60000);

  it('R2-4 the migration wizard re-run reversing a take-on journal a completed reconciliation holds -> 409, nothing written', async () => {
    const [sess] = (await sql`INSERT INTO migration_sessions (company_id, source_system, started_by)
      VALUES (${c.fx.companyId}::UUID, 'sage', ${c.fx.userId}::UUID) RETURNING id`) as Row[];
    const body = { sessionId: String(sess!.id), effectiveDate: '2026-01-01',
      balances: [{ accountCode: '1000', debit: 500, credit: 0 }, { accountCode: '3900', debit: 0, credit: 500 }] };
    const first = await call(c, token, openingBalances as Route, body);
    expect(first.status, first.body).toBe(200);
    const ob = String((first.data as { journalEntryId: string }).journalEntryId);
    const bank = c.fx.bankAccountId;
    const line = await seedLine(c, bank, 500, '2026-01-01');
    const rec = await startSession(c, token, bank);
    await matchInto(c, token, rec, { bt: line, jl: await bankLeg(ob, bank) });
    expect((await call(c, token, routes.recon, { action: 'complete', reconciliationId: rec })).status).toBe(200);
    const before = await snapshot(c, bank, rec);
    await refused(await call(c, token, openingBalances as Route, body), { bank, rec }, ob, before);
  }, 60000);

  it('R2-4b a re-run over TWO standing take-on entries, the second refused: the first one\'s reversal is not committed', async () => {
    const [sess] = (await sql`INSERT INTO migration_sessions (company_id, source_system, started_by)
      VALUES (${c.fx.companyId}::UUID, 'sage', ${c.fx.userId}::UUID) RETURNING id`) as Row[];
    const body = { sessionId: String(sess!.id), effectiveDate: '2026-01-01',
      balances: [{ accountCode: '1000', debit: 400, credit: 0 }, { accountCode: '3900', debit: 0, credit: 400 }] };
    // Run 1 posts OB1; run 2 reverses it (R1) and posts OB2; reversing R1 by hand puts OB1 back (head R2).
    const ob1 = String(((await call(c, token, openingBalances as Route, body)).data as { journalEntryId: string }).journalEntryId);
    const ob2 = String(((await call(c, token, openingBalances as Route, body)).data as { journalEntryId: string }).journalEntryId);
    const r1 = String(((await sql`SELECT id FROM gl_journal_entries WHERE reversal_of_id = ${ob1}::UUID`) as Row[])[0]!.id);
    const r2out = await reverse(r1);
    expect(r2out.status, r2out.body).toBe(200);
    const r2 = String((r2out.data as { id: string }).id);
    // OB2's cash is reconciled on a completed session.
    const bank = c.fx.bankAccountId;
    const line = await seedLine(c, bank, 400, '2026-01-01');
    const rec = await startSession(c, token, bank);
    await matchInto(c, token, rec, { bt: line, jl: await bankLeg(ob2, bank) });
    expect((await call(c, token, routes.recon, { action: 'complete', reconciliationId: rec })).status).toBe(200);
    const before = await snapshot(c, bank, rec);
    // Run 3 reverses OB1's head R2 FIRST (created first), then is refused on OB2.
    const out = await call(c, token, openingBalances as Route, body);
    expect(out.status, out.body).toBe(409);
    expect(out.body).toMatch(REFUSAL);
    expect(await reversedAt(r2), 'the first entry (through its head R2) was not reversed behind the 409').toBeNull();
    expect(((await sql`SELECT COUNT(*) AS n FROM gl_journal_entries WHERE reversal_of_id = ${r2}::UUID`) as Row[])[0]!.n,
      'no contra of the first entry').toBe('0');
    expect(await reversedAt(ob2)).toBeNull();
    expect(await snapshot(c, bank, rec)).toEqual(before);
  }, 60000);

  it('MCP reverse_journal_entry DRY RUN on the chain head of completed cash -> the same refusal (the gate; no claim is taken)', async () => {
    const bank = await newBank(c);
    const p = await seedPair(c, bank, 183.83, '2026-06-03');
    const r1 = await reverse(p.je);
    const head = String((((await reverse(String((r1.data as { id: string }).id))).data) as { id: string }).id);
    const rec = await startSession(c, token, bank);
    await matchInto(c, token, rec, p);
    expect((await call(c, token, routes.recon, { action: 'complete', reconciliationId: rec })).status).toBe(200);
    const ctx = { companyId: c.fx.companyId, userId: c.fx.userId, scopes: ['write:journals', 'write:post'], companyRole: 'owner', tokenJti: null, oauthAppId: null };
    let err: unknown = null;
    try { await inTx(c.fx, () => reverseJournalEntryTool.handler({ journal_entry_id: head, dry_run: true, idempotency_key: randomUUID() }, ctx as never)); }
    catch (e) { err = e; }
    expect(String(err)).toMatch(REFUSAL);
  }, 60000);

  it('manual evidence attach leaves a line that is no longer provisional as it is', async () => {
    const bank = await newBank(c);
    const line = await seedLine(c, bank, 77, '2026-06-11');
    const x = await provisionalX(bank, line, 77);
    // Inconsistent on purpose (no flow writes it today): the line reconciled while X still needs evidence.
    await sql`UPDATE bank_transactions SET status = 'reconciled' WHERE id = ${line}::UUID`;
    const att = await call(c, token, provisionalAttach as Route, { capturedDocumentId: await newDoc() }, { jeId: x });
    expect(att.status, att.body).toBe(200);
    expect((await lineOf(line)).status).toBe('reconciled');
  }, 60000);
});
