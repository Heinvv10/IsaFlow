/**
 * D11 round 4 (brk-d11 H1): auto_match (bank-transactions-action and the MCP perform_bank_reconciliation) with candidate
 * lines held by another transaction. `matchTransaction` locks the line outside a savepoint, so a held line's 55P03
 * aborted the request transaction: the matches already applied rolled back behind a 200 that counted them (the last line
 * held), or the next line met 25P02 and answered 400 (the first held). Each candidate now matches in its own savepoint:
 * a held line is skipped and the rest commit; if EVERY attempted line was held the request answers 503 + Retry-After.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { sql } from '@/lib/neon';
import { autoMatchTransactions } from '@/modules/accounting/services/bank/bankAutoMatchService';
import { inTx } from './helpers/l1FifoFixture';
import bankTransactionsAction from '../../pages/api/accounting/bank-transactions-action';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { request, response } from './mfa-impersonation-postgres.helpers';
import { teardown, type Ctx } from './d8-r4-helpers';
import { clearExtras, setupWithUser } from './d10-helpers';

let c: Ctx;
let token = '';
type Row = Record<string, unknown>;
async function call(body: Record<string, unknown>) {
  const req = request({ 'sb-access-token': token, active_company_id: c.fx.companyId }, 'POST') as unknown as Row;
  req.body = body; req.query = {};
  const out = response();
  const t0 = Date.now();
  await (bankTransactionsAction as (q: never, s: never) => unknown)(req as never, out.res as never);
  return { status: out.state.statusCode, ms: Date.now() - t0, retryAfter: out.headers.get('retry-after') ?? null,
    body: JSON.stringify(out.state.body).slice(0, 400) };
}
async function seedPair(amount: number, date: string, tag: string) {
  const [je] = (await sql`INSERT INTO gl_journal_entries (company_id, entry_date, description, status, created_by)
    VALUES (${c.fx.companyId}::UUID, ${date}::DATE, ${`D11 AM ${tag}`}, 'posted', ${c.fx.userId}::UUID) RETURNING id`) as Row[];
  await sql`INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit, description)
    VALUES (${c.fx.companyId}::UUID, ${je!.id}::UUID, ${c.acct.expense}::UUID, 0, ${amount}, ${`D11 AM ${tag}`}),
           (${c.fx.companyId}::UUID, ${je!.id}::UUID, ${c.fx.bankAccountId}::UUID, ${amount}, 0, ${`D11 AM ${tag}`})`;
  const [bt] = (await sql`INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date, amount, description, status)
    VALUES (${c.fx.companyId}::UUID, ${c.fx.bankAccountId}::UUID, ${date}::DATE, ${-amount}, ${`D11 AM ${tag}`}, 'imported')
    RETURNING id`) as Row[];
  return String(bt!.id);
}
const statusOf = async (ids: string[]) => ((await sql`SELECT id::TEXT AS id, status, matched_journal_line_id IS NOT NULL AS matched
  FROM bank_transactions WHERE id = ANY(${ids}::UUID[]) ORDER BY id`) as Row[]);


const matchedOf = async (ids: string[]) => (await statusOf(ids)).filter((r) => r.matched).length;
async function holdLine(id: string) {
  const h: PoolClient = await c.fx.pool.connect();
  await h.query('BEGIN');
  await h.query('SELECT id FROM bank_transactions WHERE id = $1 FOR UPDATE', [id]);
  return async () => { await h.query('ROLLBACK'); h.release(); };
}
const reported = (out: { body: string }) => Number(JSON.parse(out.body)?.data?.matched);
// The route returns only the first 400 chars of the body; the matched count is near the start.
// Each case starts from a clean candidate pool: earlier cases' lines are taken out of the 'imported' set.
async function resetMatches() {
  await sql`UPDATE bank_transactions SET status = 'excluded' WHERE company_id = ${c.fx.companyId}::UUID AND status = 'imported'`;
  await sql`DELETE FROM bank_reconciliations WHERE company_id = ${c.fx.companyId}::UUID AND status = 'in_progress'`;
}

describe.skipIf(!process.env.DATABASE_URL || !process.env.JWT_SECRET)('D11 round 4: auto_match with a held line', () => {
  beforeAll(async () => {
    assertNotProductionDb('D11 round 4 automatch');
    ({ c, token } = await setupWithUser('D11AM'));
  }, 120000);
  afterAll(async () => {
    await sql`DELETE FROM bank_reconciliations WHERE company_id = ${c.fx.companyId}::UUID`;
    await clearExtras(c); await teardown(c);
  }, 120000);
  beforeEach(resetMatches);

  it('control: two exact candidates, nothing held -> both matched', async () => {
    const ids = [await seedPair(111.11, '2026-05-25', 'c1'), await seedPair(222.22, '2026-05-26', 'c2')];
    const out = await call({ action: 'auto_match', bankAccountId: c.fx.bankAccountId });
    expect(out.status).toBe(200);
    expect(await matchedOf(ids)).toBe(2);
  }, 60000);

  it('the LAST candidate held: 200 reports exactly what commits (the other line matched), the held one skipped', async () => {
    const ids = [await seedPair(333.33, '2026-05-27', 'h1'), await seedPair(444.44, '2026-05-28', 'h2')].sort();
    const release = await holdLine(ids[1]!);
    let out;
    try { out = await call({ action: 'auto_match', bankAccountId: c.fx.bankAccountId }); } finally { await release(); }
    expect(out.status, JSON.stringify(out)).toBe(200);
    expect(reported(out)).toBe(1);
    expect(await matchedOf(ids), 'what the 200 reported is what committed').toBe(1);
    expect((await statusOf([ids[0]!]))[0]!.matched).toBe(true);
  }, 60000);

  it('the FIRST candidate held: the other line still matches and commits, no 25P02 / driver text', async () => {
    const ids = [await seedPair(555.55, '2026-05-29', 'f1'), await seedPair(666.66, '2026-05-30', 'f2')].sort();
    const release = await holdLine(ids[0]!);
    let out;
    try { out = await call({ action: 'auto_match', bankAccountId: c.fx.bankAccountId }); } finally { await release(); }
    expect(out.status, JSON.stringify(out)).toBe(200);
    expect(out.body).not.toMatch(/aborted/);
    expect(await matchedOf(ids)).toBe(1);
    expect((await statusOf([ids[1]!]))[0]!.matched).toBe(true);
  }, 60000);

  it('EVERY attempted candidate held: 503 + Retry-After, nothing committed', async () => {
    const ids = [await seedPair(777.77, '2026-05-31', 'a1')];
    const release = await holdLine(ids[0]!);
    let out;
    try { out = await call({ action: 'auto_match', bankAccountId: c.fx.bankAccountId }); } finally { await release(); }
    expect(out.status, JSON.stringify(out)).toBe(503);
    expect(out.retryAfter).toBe('2');
    expect(await matchedOf(ids)).toBe(0);
  }, 60000);

  // perform_bank_reconciliation (MCP writeBankReconciliation) calls this same service function inside the registry's
  // request transaction; its own claim step is unbounded on a held line, so the held-candidate path is driven at the
  // service the tool delegates to.
  it('the service the MCP tool calls: a held candidate is skipped and the rest commit; all held rethrows', async () => {
    const ids = [await seedPair(888.88, '2026-06-01', 'm1'), await seedPair(999.99, '2026-06-02', 'm2')].sort();
    const release = await holdLine(ids[1]!);
    let r;
    try { r = await inTx(c.fx, () => autoMatchTransactions(c.fx.companyId, c.fx.bankAccountId, undefined, c.fx.userId)); } finally { await release(); }
    expect(r.matched).toBe(1);
    expect(r.skippedRaced).toBe(1);
    expect(await matchedOf(ids), 'what the service reported is what committed').toBe(1);
    await resetMatches();
    const only = [await seedPair(123.45, '2026-06-03', 'm3')];
    const release2 = await holdLine(only[0]!);
    try {
      await expect(inTx(c.fx, () => autoMatchTransactions(c.fx.companyId, c.fx.bankAccountId, undefined, c.fx.userId))).rejects.toMatchObject({ code: 'BANK_TX_LOCK_TIMEOUT' });
    } finally { await release2(); }
    expect(await matchedOf(only)).toBe(0);
  }, 90000);
});
