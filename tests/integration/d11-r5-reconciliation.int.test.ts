/**
 * D11 round 5 (brk-d11 J1 + the auto-match observation):
 *  J1  starting a reconciliation (the HTTP start route and the MCP perform_bank_reconciliation) bulk-claims the account's
 *      open lines with NO lock bound: it waited as long as any holder. Both claim UPDATEs are now under the 5 s row-lock
 *      budget: a held line is a typed retry (503 + Retry-After over HTTP, a rethrown retry refusal via MCP), the session
 *      header rolled back, nothing written.
 *  OBS auto-match offered a line on a REVERSED journal; matchTransaction refuses it (400) with the earlier matches
 *      already committed behind that 400. The candidate query now only offers journals that stand.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { sql } from '@/lib/neon';
import bankReconciliations from '../../pages/api/accounting/bank-reconciliations';
import bankTransactionsAction from '../../pages/api/accounting/bank-transactions-action';
import { performBankReconciliationTool } from '@/lib/mcp/tools/writeBankReconciliation';
import { reverseJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostingService';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { request, response } from './mfa-impersonation-postgres.helpers';
import { inTx } from './helpers/l1FifoFixture';
import { teardown, type Ctx } from './d8-r4-helpers';
import { clearExtras, setupWithUser } from './d10-helpers';

let c: Ctx;
let token = '';
type Row = Record<string, unknown>;
type Route = (q: never, s: never) => unknown;

async function call(route: Route, body: Record<string, unknown>) {
  const req = request({ 'sb-access-token': token, active_company_id: c.fx.companyId }, 'POST') as unknown as Row;
  req.body = body; req.query = {};
  const out = response();
  const t0 = Date.now();
  await route(req as never, out.res as never);
  return { status: out.state.statusCode, ms: Date.now() - t0, retryAfter: out.headers.get('retry-after') ?? null,
    body: JSON.stringify(out.state.body).slice(0, 500) };
}
async function seedPair(amount: number, date: string, tag: string) {
  const [je] = (await sql`INSERT INTO gl_journal_entries (company_id, entry_date, description, status, created_by)
    VALUES (${c.fx.companyId}::UUID, ${date}::DATE, ${`D11 R5 ${tag}`}, 'posted', ${c.fx.userId}::UUID) RETURNING id`) as Row[];
  await sql`INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit, description)
    VALUES (${c.fx.companyId}::UUID, ${je!.id}::UUID, ${c.acct.expense}::UUID, ${amount}, 0, ${`D11 R5 ${tag}`}),
           (${c.fx.companyId}::UUID, ${je!.id}::UUID, ${c.fx.bankAccountId}::UUID, 0, ${amount}, ${`D11 R5 ${tag}`})`;
  const [bt] = (await sql`INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date, amount, description, status)
    VALUES (${c.fx.companyId}::UUID, ${c.fx.bankAccountId}::UUID, ${date}::DATE, ${-amount}, ${`D11 R5 ${tag}`}, 'imported')
    RETURNING id`) as Row[];
  return { bt: String(bt!.id), je: String(je!.id) };
}
const state = async (id: string) => ((await sql`SELECT status, matched_journal_line_id IS NOT NULL AS matched, reconciliation_id
  FROM bank_transactions WHERE id = ${id}::UUID`) as Row[])[0]!;
const sessions = async () => Number(((await sql`SELECT COUNT(*) AS n FROM bank_reconciliations
  WHERE company_id = ${c.fx.companyId}::UUID`) as Row[])[0]!.n);
async function holdLine(id: string) {
  const h: PoolClient = await c.fx.pool.connect();
  await h.query('BEGIN');
  await h.query('SELECT id FROM bank_transactions WHERE id = $1 FOR UPDATE', [id]);
  const timer = setTimeout(() => { void h.query('ROLLBACK').then(() => h.release()); }, 9000);
  let done = false;
  return async () => { if (done) return; done = true; clearTimeout(timer); await h.query('ROLLBACK').catch(() => undefined); h.release(); };
}
const mcpCtx = () => ({ userId: c.fx.userId, companyId: c.fx.companyId, scopes: ['write:bank-tx'], companyRole: 'owner', tokenJti: null, oauthAppId: null });
const startBody = () => ({ bankAccountId: c.fx.bankAccountId, statementDate: '2026-06-30', statementBalance: 0 });
async function cleanSessions() {
  await sql`UPDATE bank_transactions SET reconciliation_id = NULL WHERE company_id = ${c.fx.companyId}::UUID`;
  await sql`DELETE FROM bank_reconciliations WHERE company_id = ${c.fx.companyId}::UUID`;
  await sql`UPDATE bank_transactions SET status = 'excluded' WHERE company_id = ${c.fx.companyId}::UUID AND status = 'imported'`;
}

describe.skipIf(!process.env.DATABASE_URL || !process.env.JWT_SECRET)('D11 round 5: reconciliation start and auto-match', () => {
  beforeAll(async () => {
    assertNotProductionDb('D11 round 5');
    ({ c, token } = await setupWithUser('D11R5'));
  }, 120000);
  afterAll(async () => { await cleanSessions(); await clearExtras(c); await teardown(c); }, 120000);
  beforeEach(cleanSessions);

  it('control: start with nothing held claims the line', async () => {
    const { bt } = await seedPair(101.01, '2026-06-01', 'c1');
    const out = await call(bankReconciliations as Route, startBody());
    expect(out.status, JSON.stringify(out)).toBeLessThan(300);
    expect((await state(bt)).reconciliation_id).not.toBeNull();
  }, 60000);

  it('HTTP start with a line held 9 s: 503 + Retry-After at ~5 s, no session, line not claimed', async () => {
    const { bt } = await seedPair(202.02, '2026-06-02', 'h1');
    const release = await holdLine(bt);
    let out;
    try { out = await call(bankReconciliations as Route, startBody()); } finally { await release(); }
    expect(out.status, JSON.stringify(out)).toBe(503);
    expect(out.retryAfter).toBe('2');
    expect(out.ms).toBeGreaterThan(4000); expect(out.ms).toBeLessThan(8500);
    expect(await sessions()).toBe(0);
    expect((await state(bt)).reconciliation_id).toBeNull();
  }, 60000);

  it('MCP perform_bank_reconciliation with a line held 9 s: a retry refusal at ~5 s, nothing written', async () => {
    const { bt } = await seedPair(303.03, '2026-06-03', 'h2');
    const args = { bank_account_id: c.fx.bankAccountId, statement_date: '2026-06-30', statement_balance: 0, idempotency_key: randomUUID() };
    const release = await holdLine(bt);
    const t0 = Date.now();
    let err: unknown;
    try { await inTx(c.fx, () => performBankReconciliationTool.handler(args, mcpCtx() as never)); } catch (e) { err = e; } finally { await release(); }
    expect(err, 'a rethrown typed refusal').toBeDefined();
    expect((err as { code?: string }).code).toBe('ROW_LOCK_TIMEOUT');
    expect(Date.now() - t0).toBeGreaterThan(4000); expect(Date.now() - t0).toBeLessThan(8500);
    expect(await sessions()).toBe(0);
    expect((await state(bt)).reconciliation_id).toBeNull();
  }, 60000);

  it('auto_match: a candidate on a REVERSED journal is not offered; earlier matches commit, no 400', async () => {
    const a = await seedPair(404.04, '2026-06-04', 'r1');
    const b = await seedPair(505.05, '2026-06-05', 'r2');
    const [first, second] = a.bt < b.bt ? [a, b] : [b, a];
    await inTx(c.fx, () => reverseJournalEntry(c.fx.companyId, second.je, c.fx.userId));
    const out = await call(bankTransactionsAction as Route, { action: 'auto_match', bankAccountId: c.fx.bankAccountId });
    expect(out.status, JSON.stringify(out)).toBe(200);
    expect((await state(first.bt)).matched, 'the earlier line matched and committed').toBe(true);
    expect((await state(second.bt)).matched).toBe(false);
  }, 60000);

  it('auto_match: a BROKEN journal (stamped reversed, no posted contra) is not offered; earlier match commits, no 400', async () => {
    const a = await seedPair(606.06, '2026-06-06', 'b1');
    const b = await seedPair(707.07, '2026-06-07', 'b2');
    const [first, second] = a.bt < b.bt ? [a, b] : [b, a];
    await sql`UPDATE gl_journal_entries SET reversed_at = NOW() WHERE id = ${second.je}::UUID`;
    const out = await call(bankTransactionsAction as Route, { action: 'auto_match', bankAccountId: c.fx.bankAccountId });
    expect(out.status, JSON.stringify(out)).toBe(200);
    expect((await state(first.bt)).matched).toBe(true);
    expect((await state(second.bt)).matched).toBe(false);
    expect(out.body, 'not OFFERED (a skipped refusal would count in skippedRefused)').not.toMatch(/"skippedRefused":[1-9]/);
  }, 60000);

  it('auto_match: a candidate refused for a typed reason AFTER the offer is skipped; the run is 200, the earlier match stands', async () => {
    const a = await seedPair(808.08, '2026-06-08', 't1');
    const b = await seedPair(909.09, '2026-06-09', 't2');
    const [first, second] = a.bt < b.bt ? [a, b] : [b, a];
    // The journal is offered (it stands at read time), then reversed by a peer before this candidate's match: use a
    // trigger-free equivalent — the reversal lands between the read and the write because the line is held while we
    // reverse, so matchTransaction meets LINE_REVERSED for `second`.
    const h: PoolClient = await c.fx.pool.connect();
    await h.query('BEGIN');
    await h.query('SELECT id FROM gl_journal_entries WHERE id = $1 FOR UPDATE', [second.je]);
    const pending = call(bankTransactionsAction as Route, { action: 'auto_match', bankAccountId: c.fx.bankAccountId });
    await new Promise((r) => setTimeout(r, 1500));
    await h.query('UPDATE gl_journal_entries SET reversed_at = NOW() WHERE id = $1', [second.je]);
    await h.query('COMMIT'); h.release();
    const out = await pending;
    expect(out.status, JSON.stringify(out)).toBe(200);
    expect((await state(first.bt)).matched, 'the earlier match committed behind a 200, not a 400').toBe(true);
  }, 60000);

  it('auto_match: an imported line still linked to a provisional (D10 pre-fix data) is not offered; earlier match commits, 200', async () => {
    const a = await seedPair(1111.11, '2026-06-10', 'p1');
    const b = await seedPair(1212.12, '2026-06-11', 'p2');
    const [first, second] = a.bt < b.bt ? [a, b] : [b, a];
    await sql`UPDATE bank_transactions SET provisional_je_id = ${second.je}::UUID WHERE id = ${second.bt}::UUID`;
    const out = await call(bankTransactionsAction as Route, { action: 'auto_match', bankAccountId: c.fx.bankAccountId });
    expect(out.status, JSON.stringify(out)).toBe(200);
    expect((await state(first.bt)).matched, 'the earlier match committed behind a 200, not a 400').toBe(true);
    expect((await state(second.bt)).matched).toBe(false);
    expect(out.body).not.toMatch(/"skippedRefused":[1-9]/);
  }, 60000);
});
