/**
 * D12 round 2 — the brk-d12 attacks on b95f12121 (ATK1-ATK6, adapted from the reviewer's brk-d12-adv file), kept:
 *  B1  ATK2/2b  an adjustment held its session FOR UPDATE while its journal numbering waited on a bulk allocate that
 *               then needed the same session FOR SHARE: 40P01. Now it shares the session; deadlocks stay flat.
 *  B2  ATK1     bulk_accept waited out a held session (12 s, 200). Now 503 + Retry-After at ~5 s.
 *  B3  ATK3/3b  a generic journal reversal took a completed reconciliation's cash out of the ledger. Now 409.
 *  B4  ATK4     a completed session's matched count moved when its stale line was allocated. Now it does not.
 *  B5  ATK5/6   allocate / split / delete / bulk_accept / both bank-match-confirm settlement arms on a line IN a
 *               completed session answered 400 or a silent 200. Now the typed 409, nothing written.
 *  OBS          the automatic evidence attach set a line `matched` that was reconciled after its unlocked read.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { sql } from '@/lib/neon';
import journalEntriesAction from '../../pages/api/accounting/journal-entries-action';
import bankMatchConfirm from '../../pages/api/accounting/bank-match-confirm';
import { bulkAllocateBankTransactionsTool } from '@/lib/mcp/tools/writeBankBulkAllocate';
import { reverseJournalEntryTool } from '@/lib/mcp/tools/writeJournalReverse';
import { isRefusalCoded } from '@/lib/mcp/tools/toolHelpers';
import { allocateTransaction } from '@/modules/accounting/services/bank/bankAllocationService';
import { excludeTransaction } from '@/modules/accounting/services/bank/bankTxStatusMutations';
import { getReconciliationById } from '@/modules/accounting/services/bank/bankReconciliationService';
import { attachEvidenceToProvisional } from '@/modules/accounting/services/capture/evidenceAttachmentService';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { inTx, runOn } from './helpers/l1FifoFixture';
import { postedBill, postedInvoice, teardown, type Ctx } from './d8-r4-helpers';
import { clearExtras, setupWithUser } from './d10-helpers';
import {
  call, cleanup, completedInvariant, completedSession, lineOf, matchInto, newBank, routes, seedLine, seedPair,
  snapshot, startSession, holdSession, type Call, type Route,
} from './d12-helpers';

let c: Ctx;
let token = '';
type Row = Record<string, unknown>;
const REFUSAL = /is completed — reopen it first/;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const deadlocks = async () => Number(((await sql`SELECT deadlocks FROM pg_stat_database
  WHERE datname = current_database()`) as Row[])[0]!.deadlocks);
const ok = (o: Call) => { expect(o.status, o.body).not.toBe(500); expect(o.body).not.toMatch(/deadlock|40P01/i); };

/** A completed session over one line of `+amount` (money in), matched to a journal crediting the bank by hand. */
async function completedDeposit(amount: number) {
  const bank = await newBank(c);
  const [je] = (await sql`INSERT INTO gl_journal_entries (company_id, entry_date, description, status, created_by)
    VALUES (${c.fx.companyId}::UUID, '2026-06-05', 'D12 deposit', 'posted', ${c.fx.userId}::UUID) RETURNING id`) as Row[];
  const [jl] = (await sql`INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit, description)
    VALUES (${c.fx.companyId}::UUID, ${je!.id}::UUID, ${bank}::UUID, ${amount}, 0, 'D12 deposit') RETURNING id`) as Row[];
  await sql`INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit, description)
    VALUES (${c.fx.companyId}::UUID, ${je!.id}::UUID, ${c.acct.sales}::UUID, 0, ${amount}, 'D12 deposit')`;
  const bt = String(((await sql`INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date, amount,
    description, status) VALUES (${c.fx.companyId}::UUID, ${bank}::UUID, '2026-06-05', ${amount}, 'D12 deposit', 'imported')
    RETURNING id`) as Row[])[0]!.id);
  const rec = await startSession(c, token, bank);
  await matchInto(c, token, rec, { bt, jl: String(jl!.id) });
  const done = await call(c, token, routes.recon, { action: 'complete', reconciliationId: rec });
  if (done.status !== 200) throw new Error(JSON.stringify(done));
  return { bank, rec, bt };
}

describe.skipIf(!process.env.DATABASE_URL || !process.env.JWT_SECRET)('D12 round 2: the brk-d12 attacks', () => {
  beforeAll(async () => {
    assertNotProductionDb('D12 r2');
    ({ c, token } = await setupWithUser('D12A'));
  }, 120000);
  afterAll(async () => { await cleanup(c); await clearExtras(c); await teardown(c); }, 120000);

  it('ATK1 bulk_accept on a line of a session held FOR UPDATE: 503 + Retry-After at ~5 s, nothing written', async () => {
    const bank = await newBank(c);
    const p = await seedPair(c, bank, 111.11, '2026-06-02');
    const rec = await startSession(c, token, bank);
    const release = await holdSession(c, rec, 'UPDATE', 12000);
    let out: Call;
    try { out = await call(c, token, routes.tx, { action: 'bulk_accept', bankTransactionIds: [p.bt] }); } finally { await release(); }
    expect(out.status, out.body).toBe(503);
    expect(out.retryAfter).toBe('2');
    expect(out.ms).toBeGreaterThan(4000); expect(out.ms).toBeLessThan(8500);
    expect(await lineOf(p.bt)).toMatchObject({ status: 'imported', rec });
  }, 60000);

  it('ATK1b bulk_accept on a line a peer holds: the UPDATE itself is bounded too — 503 at ~5 s', async () => {
    const p = await seedPair(c, await newBank(c), 113.13, '2026-06-02');
    const h: PoolClient = await c.fx.pool.connect();
    await h.query('BEGIN');
    await h.query('SELECT id FROM bank_transactions WHERE id = $1 FOR UPDATE', [p.bt]);
    let out: Call;
    try { out = await call(c, token, routes.tx, { action: 'bulk_accept', bankTransactionIds: [p.bt] }); }
    finally { await h.query('ROLLBACK'); h.release(); }
    expect(out.status, out.body).toBe(503);
    expect(out.ms).toBeGreaterThan(4000); expect(out.ms).toBeLessThan(8500);
    expect((await lineOf(p.bt)).status).toBe('imported');
  }, 60000);

  it('ATK2 adjustment vs a writer that posted a journal and then locks a line of the session: no 40P01', async () => {
    const bankX = await newBank(c);
    const pX = await seedPair(c, bankX, 121.21, '2026-06-02');
    const recX = await startSession(c, token, bankX);
    const lineY = await seedLine(c, await newBank(c), 50, '2026-06-03');
    const dl0 = await deadlocks();
    const cl: PoolClient = await c.fx.pool.connect();
    await cl.query('BEGIN');
    await runOn(c.fx, cl, () => allocateTransaction(c.fx.companyId, lineY, c.acct.expense!, c.fx.userId, undefined, 'account'));
    const pA = call(c, token, routes.recon, { action: 'adjustment', reconciliationId: recX, bankAccountId: bankX,
      contraAccountId: c.acct.expense, amount: 5, description: 'd12 atk2' });
    await sleep(400);
    let bErr: unknown = null;
    try {
      await runOn(c.fx, cl, () => allocateTransaction(c.fx.companyId, pX.bt, c.acct.expense!, c.fx.userId, undefined, 'account'));
    } catch (e) { bErr = e; }
    await cl.query(bErr ? 'ROLLBACK' : 'COMMIT');
    cl.release();
    const a = await pA;
    await sleep(1500);
    expect(await deadlocks() - dl0, 'Postgres detected a deadlock').toBe(0);
    ok(a);
    expect(bErr, String(bErr)).toBeNull();
    expect([200, 503], a.body).toContain(a.status);
    expect((await lineOf(pX.bt)).status).toBe('allocated');
  }, 60000);

  it('ATK2b the real MCP bulk_allocate_bank_transactions (41 lines) vs the adjustment route: no 40P01', async () => {
    const bankX = await newBank(c);
    const xId = `ffffffff-ffff-4fff-bfff-${randomUUID().slice(-12)}`;
    await sql`INSERT INTO bank_transactions (id, company_id, bank_account_id, transaction_date, amount, description, status)
      VALUES (${xId}::UUID, ${c.fx.companyId}::UUID, ${bankX}::UUID, '2026-06-04', -77, 'd12 X', 'imported')`;
    const recX = await startSession(c, token, bankX);
    const bankY = await newBank(c);
    const ys: string[] = [];
    for (let i = 0; i < 40; i++) {
      const id = `00000000-0000-4000-8000-${randomUUID().slice(-12)}`;
      await sql`INSERT INTO bank_transactions (id, company_id, bank_account_id, transaction_date, amount, description, status)
        VALUES (${id}::UUID, ${c.fx.companyId}::UUID, ${bankY}::UUID, '2026-06-05', ${-(10 + i)}, ${`d12 Y${i}`}, 'imported')`;
      ys.push(id);
    }
    const dl0 = await deadlocks();
    const ctx = { companyId: c.fx.companyId, userId: c.fx.userId, scopes: ['write:bank-tx', 'write:post'], tokenJti: null, oauthAppId: null };
    const allocations = [...ys, xId].map((id) => ({ transaction_id: id, alloc_type: 'account', contra_account_id: c.acct.expense, vat_code: 'none' }));
    const pB = inTx(c.fx, () => bulkAllocateBankTransactionsTool.handler({ allocations, idempotency_key: randomUUID() }, ctx as never))
      .then((r) => ({ ok: true as const, r }), (e: unknown) => ({ ok: false as const, e }));
    await sleep(150);
    const a = await call(c, token, routes.recon, { action: 'adjustment', reconciliationId: recX, bankAccountId: bankX,
      contraAccountId: c.acct.expense, amount: 5, description: 'd12 atk2b' });
    const b = await pB;
    await sleep(1500);
    expect(await deadlocks() - dl0, 'Postgres detected a deadlock').toBe(0);
    ok(a);
    expect([200, 503], a.body).toContain(a.status);
    expect(b.ok, b.ok ? '' : String(b.e)).toBe(true);
    expect((await lineOf(xId)).status, 'the bulk allocate reached the session line').toBe('allocated');
  }, 90000);

  it('ATK2c adjustment while a writer SHARES the session and then posts a journal: no 40P01, the refresh is skipped', async () => {
    const bankX = await newBank(c);
    const pX = await seedPair(c, bankX, 141.41, '2026-06-02');
    const recX = await startSession(c, token, bankX);
    const rb0 = Number(((await sql`SELECT reconciled_balance FROM bank_reconciliations WHERE id = ${recX}::UUID`) as Row[])[0]!.reconciled_balance);
    const lineY = await seedLine(c, await newBank(c), 60, '2026-06-03');
    const dl0 = await deadlocks();
    // B shares X's session (an exclude of X's line locks it), posting nothing yet.
    const cl: PoolClient = await c.fx.pool.connect();
    await cl.query('BEGIN');
    await runOn(c.fx, cl, () => excludeTransaction(c.fx.companyId, pX.bt, 'd12 atk2c'));
    // A posts its journal while B shares the session; its header refresh must not wait on B.
    const pA = call(c, token, routes.recon, { action: 'adjustment', reconciliationId: recX, bankAccountId: bankX,
      contraAccountId: c.acct.expense, amount: 7, description: 'd12 atk2c' });
    await sleep(600);
    // B's next write posts a journal: its number waits on A's uncommitted one.
    let bErr: unknown = null;
    try {
      await runOn(c.fx, cl, () => allocateTransaction(c.fx.companyId, lineY, c.acct.expense!, c.fx.userId, undefined, 'account'));
    } catch (e) { bErr = e; }
    await cl.query(bErr ? 'ROLLBACK' : 'COMMIT');
    cl.release();
    const a = await pA;
    await sleep(1500);
    expect(await deadlocks() - dl0, 'Postgres detected a deadlock').toBe(0);
    ok(a);
    expect(a.status, a.body).toBe(200);
    // B lost the pre-existing journal-number race to A, or won it — never a deadlock.
    if (bErr) expect((bErr as { constraint?: string }).constraint, String(bErr)).toBe('uq_gl_je_company_entry_number');
    expect(Number(((await sql`SELECT reconciled_balance FROM bank_reconciliations WHERE id = ${recX}::UUID`) as Row[])[0]!.reconciled_balance),
      'the refresh was skipped while B shared the session').toBe(rb0);
  }, 60000);

  it('ATK3 journal-entries-action reverse of the journal behind a RECONCILED line of a completed session -> 409', async () => {
    const s = await completedSession(c, token, { matched: 1 });
    const line = s.matched[0]!;
    const before = await snapshot(c, s.bank, s.rec);
    const out = await call(c, token, journalEntriesAction as Route, { id: line.je, action: 'reverse' });
    expect(out.status, out.body).toBe(409);
    expect(out.body).toMatch(REFUSAL);
    expect(await snapshot(c, s.bank, s.rec)).toEqual(before);
    expect(await completedInvariant(c, s.bank, s.rec, true)).toBeNull();
  }, 60000);

  it('ATK3b MCP reverse_journal_entry of that journal -> a refusal, no contra', async () => {
    const s = await completedSession(c, token, { matched: 1 });
    const line = s.matched[0]!;
    const before = await snapshot(c, s.bank, s.rec);
    const ctx = { companyId: c.fx.companyId, userId: c.fx.userId, scopes: ['write:journals', 'write:post'], tokenJti: null, oauthAppId: null };
    let err: unknown = null;
    try { await inTx(c.fx, () => reverseJournalEntryTool.handler({ journal_entry_id: line.je, idempotency_key: randomUUID() }, ctx as never)); }
    catch (e) { err = e; }
    expect(isRefusalCoded(err), String(err)).toBe(true);
    expect((err as Error).message).toMatch(REFUSAL);
    expect(await snapshot(c, s.bank, s.rec)).toEqual(before);
  }, 60000);

  it('ATK3 control: reversing a journal whose line sits in an IN-PROGRESS session is not refused here', async () => {
    const bank = await newBank(c);
    const p = await seedPair(c, bank, 131.31, '2026-06-02');
    const rec = await startSession(c, token, bank);
    await matchInto(c, token, rec, p);
    const out = await call(c, token, journalEntriesAction as Route, { id: p.je, action: 'reverse' });
    expect(out.status, out.body).toBe(200);
  }, 60000);

  it('ATK4 allocating a STALE-stamped line of a completed session does not move its matched count', async () => {
    const s = await completedSession(c, token, { matched: 1, stale: 1 });
    const r0 = (await getReconciliationById(c.fx.companyId, s.rec))!;
    const out = await call(c, token, routes.tx, { action: 'allocate', bankTransactionId: s.stale[0]!,
      allocationType: 'account', contraAccountId: c.acct.expense });
    expect(out.status, out.body).toBe(200);
    const r1 = (await getReconciliationById(c.fx.companyId, s.rec))!;
    expect(r1.matchedCount, 'a completed session gained a matched line').toBe(r0.matchedCount);
    expect(r1.matchedCount).toBe(1);
  }, 60000);

  for (const [name, body] of [
    ['allocate', (bt: string) => ({ action: 'allocate', bankTransactionId: bt, allocationType: 'account', contraAccountId: c.acct.expense })],
    ['split_allocate', (bt: string) => ({ action: 'split_allocate', bankTransactionId: bt, lines: [{ contraAccountId: c.acct.expense, amount: 100 }] })],
    ['delete', (bt: string) => ({ action: 'delete', bankTransactionIds: [bt] })],
    ['bulk_accept', (bt: string) => ({ action: 'bulk_accept', bankTransactionIds: [bt] })],
  ] as const) {
    it(`ATK5 ${name} on a RECONCILED line of a completed session -> 409, nothing written`, async () => {
      const s = await completedSession(c, token, { matched: 1, stale: 1 });
      const before = await snapshot(c, s.bank, s.rec);
      // delete / bulk_accept name an innocent (stale) line too: the WHOLE request is refused.
      const out = await call(c, token, routes.tx, name === 'delete' || name === 'bulk_accept'
        ? { ...body(s.matched[0]!.bt), bankTransactionIds: [s.stale[0]!, s.matched[0]!.bt] } : body(s.matched[0]!.bt));
      expect(out.status, out.body).toBe(409);
      expect(out.body).toMatch(REFUSAL);
      expect(await snapshot(c, s.bank, s.rec)).toEqual(before);
    }, 60000);
  }

  it('ATK6 bank-match-confirm supplier_invoice arm on a RECONCILED line -> 409, no payment, bill untouched', async () => {
    const s = await completedSession(c, token, { matched: 1 });
    const bill = await postedBill(c);
    const before = await snapshot(c, s.bank, s.rec);
    const out = await call(c, token, bankMatchConfirm as Route,
      { bankTransactionId: s.matched[0]!.bt, candidateType: 'supplier_invoice', candidateId: bill.id });
    expect(out.status, out.body).toBe(409);
    expect(out.body).toMatch(REFUSAL);
    expect(await snapshot(c, s.bank, s.rec)).toEqual(before);
    expect(Number(((await sql`SELECT amount_paid FROM supplier_invoices WHERE id = ${bill.id}::UUID`) as Row[])[0]!.amount_paid)).toBe(0);
  }, 60000);

  it('ATK6 bank-match-confirm customer_invoice arm on a RECONCILED deposit -> 409, no receipt', async () => {
    const s = await completedDeposit(230);
    const inv = await postedInvoice(c);
    const before = await snapshot(c, s.bank, s.rec);
    const out = await call(c, token, bankMatchConfirm as Route,
      { bankTransactionId: s.bt, candidateType: 'customer_invoice', candidateId: inv.id });
    expect(out.status, out.body).toBe(409);
    expect(out.body).toMatch(REFUSAL);
    expect(await snapshot(c, s.bank, s.rec)).toEqual(before);
  }, 60000);

  it('OBS the automatic evidence attach leaves a line reconciled after its unlocked read as it is', async () => {
    const bank = await newBank(c);
    const line = await seedLine(c, bank, 140, '2026-06-11');
    const [x] = (await sql`INSERT INTO gl_journal_entries (company_id, entry_date, description, source, status, created_by,
        posting_agent, needs_evidence) VALUES (${c.fx.companyId}::UUID, '2026-06-11', 'D12 provisional', 'auto_bank_recon',
        'draft', ${c.fx.userId}::UUID, 'ai-provisional:v1', true) RETURNING id`) as Row[];
    await sql`INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit, description)
      VALUES (${c.fx.companyId}::UUID, ${x!.id}::UUID, ${c.acct.expense}::UUID, 140, 0, 'p'),
             (${c.fx.companyId}::UUID, ${x!.id}::UUID, ${bank}::UUID, 0, 140, 'p')`;
    await sql`UPDATE gl_journal_entries SET status = 'posted', posted_at = NOW() WHERE id = ${x!.id}::UUID`;
    await sql`UPDATE bank_transactions SET status = 'provisional', provisional_je_id = ${x!.id}::UUID WHERE id = ${line}::UUID`;
    const doc = randomUUID();
    await sql`INSERT INTO captured_documents (id, company_id, file_name, file_type, document_type, extracted_data, status)
      VALUES (${doc}::UUID, ${c.fx.companyId}::UUID, ${`d12-${doc}.pdf`}, 'application/pdf', 'invoice', '{}'::jsonb, 'pending')`;
    // B reconciles the line (uncommitted) after A's unlocked read can still see it provisional.
    const h: PoolClient = await c.fx.pool.connect();
    await h.query('BEGIN');
    await h.query("UPDATE bank_transactions SET status = 'reconciled' WHERE id = $1", [line]);
    const pA = inTx(c.fx, () => attachEvidenceToProvisional(c.fx.companyId, doc, null, 140, '2026-06-11'));
    await sleep(1000);
    await h.query('COMMIT'); h.release();
    await pA;
    expect((await lineOf(line)).status, 'not turned matched over the reconciliation').toBe('reconciled');
    await sql`UPDATE bank_transactions SET provisional_je_id = NULL WHERE id = ${line}::UUID`;
  }, 60000);
});
