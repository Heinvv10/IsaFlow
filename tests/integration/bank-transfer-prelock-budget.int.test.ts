/**
 * WP2 row 5 round 2 (brk-1494): the multi-journal pre-lock (transferSweepPrelock) under contention.
 *
 *  - LOW 2: two pairs held by another request cost 5 s EACH, serially. Now one total budget: both skipped and counted
 *    within ~5 s, the batch's other line posted.
 *  - The deadlock recipe: pair AB held; a bulk batch queues for AB; a gate run queues for AB; a person's screen
 *    allocation of the bulk's line queues behind it; AB released. Before: two 40P01s — the gate's whole request 503,
 *    the bulk "deadlock", nothing committed. Now (line -> pair -> number everywhere, a 40P01 in the pre-lock a skip):
 *    no deadlock, each movement posted exactly once.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import type { NextApiResponse } from 'next';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser } from './r035-approval.helpers';
import { actionRoute, bankCompany, cleanupBankControlsA, mcpCaller, type BankCompany } from './bank-controls-a.helpers';
import { bulkAllocateBankTransactionsTool } from '../../src/lib/mcp/tools/writeBankBulkAllocate';
import { withAuth, type CompanyAuthedRequest } from '../../src/lib/auth';
import { sweep } from '../../src/modules/accounting/services/bank/autoPostGateService';
import { transferPairKey } from '../../src/modules/accounting/services/bank/transferPairLock';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let user = '';
let f: BankCompany;
let bankC = '';
const mcp = mcpCaller(pool, [bulkAllocateBankTransactionsTool]);
type Bulk = { posted: number; skipped: Array<{ transaction_id: string; reason: string }> };
const bulkOf = (r: { content: { text: string }[] }) => JSON.parse(r.content[0]!.text) as Bulk;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const deadlocks = async () => Number((await pool.query(
  'SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()')).rows[0].deadlocks);
const transfers = async () => (await pool.query(`SELECT count(*)::int AS n FROM gl_journal_entries
  WHERE company_id = $1 AND source = 'auto_bank_transfer' AND status = 'posted'`, [f.c])).rows[0].n as number;
const status = async (id: string) => (await pool.query('SELECT status FROM bank_transactions WHERE id = $1', [id])).rows[0].status as string;
const lineOn = async (amount: number, description: string) => (await pool.query(
  `INSERT INTO bank_transactions(company_id, bank_account_id, transaction_date, amount, description, status)
   VALUES($1,$2,DATE '2026-09-01',$3,$4,'imported') RETURNING id`, [f.c, f.bank, amount, description])).rows[0].id as string;
/** Another request holding these pairs (an open transaction). */
async function holdPairs(pairs: Array<[string, string]>): Promise<PoolClient> {
  const holder = await pool.connect();
  await holder.query('BEGIN');
  for (const [x, y] of pairs) await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [transferPairKey(f.c, x, y)]);
  return holder;
}
/** Waits (bounded) until `n` sessions wait on the given lock kind. */
async function waiters(event: string, n: number): Promise<void> {
  for (let i = 0; i < 400; i++) {
    const got = Number((await pool.query(`SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock' AND wait_event = $1`, [event])).rows[0].n);
    if (got >= n) return;
    await sleep(20);
  }
  throw new Error(`never saw ${n} waiter(s) on ${event}`);
}

beforeAll(async () => {
  user = await createUser(pool, tokens);
  f = await bankCompany(pool, [[user, 'admin']], companies);
  bankC = (await pool.query(
    `INSERT INTO gl_accounts(company_id,account_code,account_name,account_type,normal_balance,is_active,account_subtype)
     VALUES ($1,$2,'BPB Bank 3','asset','debit',true,'bank') RETURNING id`, [f.c, `B3${f.c.slice(0, 6)}`])).rows[0].id as string;
  await pool.query(`INSERT INTO bank_auto_post_settings(company_id, enabled, min_confidence, amount_cap, llm_enabled,
    llm_min_confidence, llm_amount_cap, updated_at) VALUES ($1, true, 0.50, 0, false, 0.95, 2000, NOW())`, [f.c]);
}, 60000);
afterAll(async () => {
  await pool.query('UPDATE bank_transactions SET allocation_batch_id = NULL WHERE company_id = $1', [f.c]);
  await cleanupBankControlsA(pool, companies, [user]); // ends the pool
}, 60000);

describe('the pre-lock spends ONE budget', () => {
  it('two held pairs: both skipped and counted within ~5 s, the plain line posts', async () => {
    const [toB, toC, plain] = [await lineOn(-701, 'BPB B'), await lineOn(-702, 'BPB C'), await lineOn(-703, 'BPB plain')];
    const holder = await holdPairs([[f.bank, f.bank2], [f.bank, bankC]]);
    let ms = 0;
    let out: Bulk;
    try {
      const t0 = Date.now();
      out = bulkOf(await mcp(user, f.c, 'bulk_allocate_bank_transactions', { idempotency_key: crypto.randomUUID(), allocations: [
        { transaction_id: toB, alloc_type: 'account', contra_account_id: f.bank2 },
        { transaction_id: toC, alloc_type: 'account', contra_account_id: bankC },
        { transaction_id: plain, alloc_type: 'account', contra_account_id: f.expA }] }));
      ms = Date.now() - t0;
    } finally { await holder.query('ROLLBACK'); holder.release(); }
    expect(out.posted).toBe(1);
    expect(out.skipped.map((s) => [s.transaction_id, s.reason]).sort()).toEqual(
      [[toB, expect.stringMatching(/locked by another request/)], [toC, expect.stringMatching(/locked by another request/)]].sort());
    expect({ b: await status(toB), c: await status(toC), plain: await status(plain) }).toEqual({ b: 'imported', c: 'imported', plain: 'allocated' });
    expect(ms, `the pre-lock waited ${ms} ms for two held pairs`).toBeLessThan(7000); // was ~10 000 (5 s each)
  }, 60000);
});

describe('the brk-1494 deadlock recipe', () => {
  it('pair held; bulk, gate and a person queue; released: no deadlock, every movement once', async () => {
    const l = await lineOn(-811, 'BPB L');
    const m = await lineOn(-812, 'BPB M');
    await pool.query('UPDATE bank_transactions SET suggested_gl_account_id = $2, suggested_confidence = 0.95 WHERE id = $1', [m, f.bank2]);
    const before = await transfers();
    const dl0 = await deadlocks();
    const holder = await holdPairs([[f.bank, f.bank2]]);
    let bulk: Promise<unknown>; let gate: Promise<{ state: { statusCode: number; body: unknown } }>;
    let screen: Promise<{ state: { statusCode: number; body: unknown } }>;
    try {
      bulk = mcp(user, f.c, 'bulk_allocate_bank_transactions', { idempotency_key: crypto.randomUUID(),
        allocations: [{ transaction_id: l, alloc_type: 'account', contra_account_id: f.bank2 }] });
      await waiters('advisory', 1);
      const run = withAuth(async (req: CompanyAuthedRequest, res: NextApiResponse) => {
        res.status(200).json({ data: await sweep(req.companyId, [m], 'categorization', req.user.id, req.user.id) });
      });
      gate = callRoute(run as never, tokens[user]!, f.c, 'POST', {}, '/api/accounting/smart-categorize');
      await waiters('advisory', 2);
      screen = actionRoute(tokens)(user, f.c, { action: 'allocate', bankTransactionId: l, allocationType: 'account', contraAccountId: f.bank2 });
      await waiters('transactionid', 1); // the person waits on the bulk's line lock
    } finally { await holder.query('ROLLBACK'); holder.release(); }
    const [b, g, s] = await Promise.all([bulk!, gate!, screen!]);
    expect(bulkOf(b as { content: { text: string }[] })).toMatchObject({ posted: 1, skipped: [] });
    expect(g.state.statusCode, JSON.stringify(g.state.body)).toBe(200);
    expect((g.state.body as { data: { posted: number } }).data.posted).toBe(1);
    expect(s.state.statusCode, JSON.stringify(s.state.body)).toBe(400); // already allocated by the bulk: no second post
    expect({ l: await status(l), m: await status(m), journals: await transfers() - before }).toEqual({ l: 'allocated', m: 'allocated', journals: 2 });
    expect(await deadlocks() - dl0, 'the database broke a deadlock (40P01)').toBe(0);
  }, 60000);
});
