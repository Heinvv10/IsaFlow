/**
 * WP6 round 2, the adversarial reviewer's findings: the batch undo must not reverse a hand re-allocation (F1), the confirm
 * takes its line locks up front so it neither deadlocks with a single accept nor waits per held line (F2/F3), the preview
 * scan is bounded and keeps eligible lines visible (F5), and the token pins amount and date, the quota is spent only by a
 * request that gets to work, and refusals are labelled by code (W2, W4, W5).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import bulkAccept from '../../pages/api/accounting/bank-bulk-accept';
import bankTransactionsAction from '../../pages/api/accounting/bank-transactions-action';
import autoPost from '../../pages/api/accounting/bank-auto-post';
import { sweep } from '../../src/modules/accounting/services/bank/autoPostGateService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser } from './r035-approval.helpers';
import { dataOf } from './r035-pr2.helpers';
import { asToken, bankCompany, cleanupBankControlsA, enforce, type BankCompany } from './bank-controls-a.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let a = '';
let b = '';
const URL = '/api/accounting/bank-bulk-accept';

beforeAll(async () => { a = await createUser(pool, tokens); b = await createUser(pool, tokens); });
afterAll(async () => {
  await pool.query('UPDATE bank_transactions SET auto_post_run_id = NULL WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM bank_transactions WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM bank_import_batches WHERE company_id = ANY($1)', [companies]);
  await cleanupBankControlsA(pool, companies, [a, b]); // ends the pool
});

async function fixture(): Promise<BankCompany> {
  const f = await bankCompany(pool, [[a, 'admin'], [b, 'admin']], companies);
  await pool.query(
    `INSERT INTO bank_auto_post_settings(company_id, enabled, min_confidence, amount_cap, llm_enabled, llm_min_confidence, llm_amount_cap)
     VALUES($1, true, 0.50, 0, false, 0.95, 0)`, [f.c]);
  return f;
}
async function suggested(f: BankCompany, o: { id?: string; amount?: number; confidence?: number; strategy?: string; date?: string; batch?: string } = {}) {
  const cols = ['company_id', 'bank_account_id', 'transaction_date', 'amount', 'description', 'status', 'suggested_gl_account_id', 'suggested_confidence', 'suggested_strategy', 'import_batch_id'];
  const vals: unknown[] = [f.c, f.bank, o.date ?? '2026-09-01', o.amount ?? -100, 'BULK3 line', 'imported', f.expA, o.confidence ?? 0.97, o.strategy ?? 'history', o.batch ?? null];
  if (o.id) { cols.push('id'); vals.push(o.id); }
  return (await pool.query(`INSERT INTO bank_transactions(${cols.join(',')}) VALUES(${cols.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`, vals)).rows[0].id as string;
}
const get = (f: BankCompany, query: Record<string, string>, user = a) => callRoute(bulkAccept, tokens[user]!, f.c, 'GET', undefined, URL, { bankAccountId: f.bank, ...query });
const post = (f: BankCompany, body: Record<string, unknown>, user = a) => callRoute(bulkAccept, tokens[user]!, f.c, 'POST', body, URL);
const act = (f: BankCompany, body: Record<string, unknown>) => callRoute(bankTransactionsAction, tokens[a]!, f.c, 'POST', body, '/api/accounting/bank-transactions-action');
type Prev = { previewToken: string; lines: { id: string }[]; scanTruncated: boolean; truncated: boolean };
type Confirmed = { runId: string | null; posted: { txId: string; journalEntryId: string }[]; refused: { txId: string; reason: string }[] };
const previewOf = async (f: BankCompany) => dataOf<Prev>(await get(f, {}));
const confirmed = async (f: BankCompany, token: string) => dataOf<Confirmed>(await post(f, { action: 'confirm', previewToken: token }));
const tag = async (id: string) => (await pool.query('SELECT auto_post_run_id::TEXT AS t, status FROM bank_transactions WHERE id = $1', [id])).rows[0] as { t: string | null; status: string };
const journalOf = async (id: string) => (await pool.query(
  `SELECT je.id::TEXT AS id, je.status, je.reversed_by IS NOT NULL AS reversed FROM bank_transactions bt
   JOIN gl_journal_lines l ON l.id = bt.matched_journal_line_id JOIN gl_journal_entries je ON je.id = l.journal_entry_id WHERE bt.id = $1`, [id])).rows[0] as { id: string; status: string; reversed: boolean } | undefined;
const reversals = async (c: string) => (await pool.query('SELECT COUNT(*)::INT AS n FROM gl_journal_entries WHERE company_id = $1 AND reversal_of_id IS NOT NULL', [c])).rows[0].n as number;
const journals = async (c: string) => (await pool.query('SELECT COUNT(*)::INT AS n FROM gl_journal_entries WHERE company_id = $1', [c])).rows[0].n as number;
const handRecode = async (f: BankCompany, id: string) => {
  expect((await act(f, { action: 'reverse', bankTransactionId: id })).state.statusCode).toBe(200);
  const res = await act(f, { action: 'allocate', bankTransactionId: id, contraAccountId: f.expB });
  expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
};

describe('F1: an undo does not reverse a hand re-allocation', () => {
  async function bulkRun(f: BankCompany) {
    const ids = [await suggested(f, { amount: -10 }), await suggested(f, { amount: -20 })];
    ids.sort();
    const out = await confirmed(f, (await previewOf(f)).previewToken);
    expect(out.posted).toHaveLength(2);
    return { ids, runId: out.runId!, journalOf: new Map(out.posted.map((p) => [p.txId, p.journalEntryId])) };
  }

  it('the reviewer\'s repro: confirm two lines, hand reverse and re-allocate line 0, undo the batch: only line 1 is reversed', async () => {
    const f = await fixture();
    const { ids, runId } = await bulkRun(f);
    await handRecode(f, ids[0]!);
    const hand = await journalOf(ids[0]!);
    const res = dataOf<{ reversed: number }>(await post(f, { action: 'undo', runId }));
    expect(res.reversed).toBe(1);
    expect((await tag(ids[1]!)).status).toBe('imported');
    expect((await tag(ids[0]!)).status).toBe('allocated');
    expect(await journalOf(ids[0]!)).toEqual(hand);
    expect(hand).toMatchObject({ status: 'posted', reversed: false });
    expect(await reversals(f.c)).toBe(2); // the hand reversal of line 0 and the undo of line 1, nothing more
  });

  it('(a) a hand reverse takes the line out of its run', async () => {
    const f = await fixture();
    const { ids } = await bulkRun(f);
    expect((await act(f, { action: 'reverse', bankTransactionId: ids[0]! })).state.statusCode).toBe(200);
    expect((await tag(ids[0]!)).t).toBeNull();
  });

  it('(b) a hand allocation takes the line out of any run it still carried', async () => {
    const f = await fixture();
    const { runId } = await bulkRun(f);
    const stale = await suggested(f, { amount: -5, confidence: 0.1 });
    await pool.query('UPDATE bank_transactions SET auto_post_run_id = $2 WHERE id = $1', [stale, runId]);
    expect((await act(f, { action: 'allocate', bankTransactionId: stale, contraAccountId: f.expB })).state.statusCode).toBe(200);
    expect((await tag(stale)).t).toBeNull();
  });

  it('(c) even a line that still carries the run\'s tag is left alone when its posting is not the run\'s', async () => {
    const f = await fixture();
    const { ids, runId, journalOf: original } = await bulkRun(f);
    await handRecode(f, ids[0]!);
    await pool.query('UPDATE bank_transactions SET auto_post_run_id = $2, auto_post_journal_id = $3 WHERE id = $1', [ids[0], runId, original.get(ids[0]!)]); // residue
    const hand = await journalOf(ids[0]!);
    const res = dataOf<{ reversed: number; skipped: number; skippedBy: { changedSinceRun: number }; undone: boolean }>(await post(f, { action: 'undo', runId }));
    expect(res).toMatchObject({ reversed: 1, skipped: 1, undone: false });
    expect(res.skippedBy.changedSinceRun).toBe(1);
    expect(await journalOf(ids[0]!)).toEqual(hand);
    expect((await tag(ids[0]!)).t).toBeNull();
    expect(dataOf<{ undone: boolean }>(await post(f, { action: 'undo', runId })).undone).toBe(true); // the line left the run: it can close
  });

  it('the same for an auto-post sweep run (the rule path): undo reverses the untouched line only', async () => {
    const f = await fixture();
    const ids = [await suggested(f, { amount: -10 }), await suggested(f, { amount: -20 })];
    ids.sort();
    const swept = await asToken(pool, a, f.c, () => sweep(f.c, ids, 'categorization', a, a));
    expect(swept.posted).toBe(2);
    await handRecode(f, ids[0]!);
    const hand = await journalOf(ids[0]!);
    const res = await callRoute(autoPost, tokens[a]!, f.c, 'POST', { action: 'undo', runId: swept.runId }, '/api/accounting/bank-auto-post');
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    expect(dataOf<{ reversed: number }>(res).reversed).toBe(1);
    expect(await journalOf(ids[0]!)).toEqual(hand);
    expect((await tag(ids[1]!)).status).toBe('imported');
  });
});

describe('F2: a confirm racing single accepts neither deadlocks nor double-posts', () => {
  it('15 lines against 15 concurrent single accepts, three rounds: no deadlock, each line posted once, the GL balances', async () => {
    const f = await fixture();
    const deadlocks = async () => Number((await pool.query('SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()')).rows[0].deadlocks);
    const before = await deadlocks();
    for (let round = 0; round < 3; round += 1) {
      const ids: string[] = [];
      for (let i = 0; i < 15; i += 1) ids.push(await suggested(f, { amount: -10 - i - round * 100 }));
      const token = (await previewOf(f)).previewToken;
      await Promise.all([post(f, { action: 'confirm', previewToken: token }),
        ...ids.map((id) => act(f, { action: 'allocate', bankTransactionId: id, contraAccountId: f.expB }))]);
    }
    await new Promise((r) => setTimeout(r, 2_500)); // pg_stat_database lags the backends
    expect((await deadlocks()) - before).toBe(0);
    const allocated = (await pool.query("SELECT COUNT(*)::INT AS n FROM bank_transactions WHERE company_id = $1 AND status = 'allocated'", [f.c])).rows[0].n as number;
    expect(await journals(f.c)).toBe(allocated); // one journal per allocated line: nothing posted twice
    const sums = (await pool.query('SELECT SUM(debit)::FLOAT AS d, SUM(credit)::FLOAT AS c FROM gl_journal_lines WHERE company_id = $1', [f.c])).rows[0];
    expect(sums.d).toBe(sums.c);
  }, 120_000);
});

describe('F5: the preview scan', () => {
  const bulkInsert = (f: BankCompany, count: number, idPrefix: string, strategy: string, date = '2026-09-01') => pool.query(
    `INSERT INTO bank_transactions(id, company_id, bank_account_id, transaction_date, amount, description, status, suggested_gl_account_id, suggested_confidence, suggested_strategy)
     SELECT ($1 || lpad(g::TEXT, 12, '0'))::UUID, $2, $3, $6::DATE, -1, 'BULK3 filler', 'imported', $4, 0.97, $5 FROM generate_series(1, $7) g`,
    [idPrefix, f.c, f.bank, f.expA, strategy, date, count]);

  it('5 eligible lines behind 1 005 shared-pool ones are still listed (every predicate is in SQL)', async () => {
    const f = await fixture();
    await bulkInsert(f, 1005, '00000000-0000-4000-8000-', 'shared_pool');
    await bulkInsert(f, 5, 'ffffffff-ffff-4fff-8fff-', 'history');
    const p = await previewOf(f);
    expect(p.lines).toHaveLength(5);
    expect(p.scanTruncated).toBe(false);
  });

  it('a scan that hits its row cap with candidates unread says so: lines the SQL cannot rule out hide the rest', async () => {
    const f = await fixture();
    await bulkInsert(f, 2100, '11111111-1111-4111-8111-', 'history', '2005-05-01'); // no period and outside the auto-create window: screened out in JS
    await bulkInsert(f, 3, 'fefefefe-fefe-4efe-8efe-', 'history');
    const p = await previewOf(f);
    expect(p.lines).toHaveLength(0);
    expect(p.scanTruncated).toBe(true);
  }, 60_000);
});

describe('round 3 review', () => {
  it('N2: held lines are capped at 50 in the answer and the scan stops once it has met that many', async () => {
    const f = await fixture();
    await enforce(pool, f.c, a, ['manual_journal']);
    const batch = (await pool.query(
      `INSERT INTO bank_import_batches(company_id, bank_account_id, statement_date, transaction_count, imported_by, import_channel) VALUES($1,$2,DATE '2026-09-30',600,$3,'upload') RETURNING id`, [f.c, f.bank, a])).rows[0].id;
    await pool.query(
      `INSERT INTO bank_transactions(id, company_id, bank_account_id, transaction_date, amount, description, status, suggested_gl_account_id, suggested_confidence, suggested_strategy, import_batch_id)
       SELECT ('22222222-2222-4222-8222-' || lpad(g::TEXT, 12, '0'))::UUID, $1, $2, DATE '2026-09-01', -1, 'BULK3 held', 'imported', $3, 0.97, 'history', $4 FROM generate_series(1, 600) g`, [f.c, f.bank, f.expA, batch]);
    await suggested(f, { id: 'efefefef-efef-4fef-8fef-000000000001' }); // behind the 600 held lines
    const p = dataOf<Prev & { needsAttention: unknown[]; needsAttentionCount: number }>(await get(f, {}));
    expect(p.needsAttention).toHaveLength(50);
    expect(p.needsAttentionCount).toBe(500); // the first page; the second was never read
    expect(p.lines).toHaveLength(0);
    expect(p.scanTruncated).toBe(true);
  }, 60_000);

  it('N3: a month with no period that the single accept would create is let through to the confirm, which posts it', async () => {
    const f = await fixture();
    const id = await suggested(f, { date: '2025-05-15' }); // inside the window, no 2025 period exists
    const p = await previewOf(f);
    expect(p.lines.map((l) => l.id)).toEqual([id]);
    const out = await confirmed(f, p.previewToken);
    expect(out.posted, JSON.stringify(out.refused)).toHaveLength(1);
  });

  it('N4: a line stamped to a reconciliation after the preview is refused at once, without waiting on the session\'s lock', async () => {
    const f = await fixture();
    const id = await suggested(f);
    const token = (await previewOf(f)).previewToken;
    const rec = (await pool.query(`INSERT INTO bank_reconciliations(company_id, bank_account_id, statement_date, started_by) VALUES($1,$2,DATE '2026-09-30',$3) RETURNING id`, [f.c, f.bank, a])).rows[0].id;
    await pool.query('UPDATE bank_transactions SET reconciliation_id = $2 WHERE id = $1', [id, rec]);
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM bank_reconciliations WHERE id = $1 FOR UPDATE', [rec]); // would make the per-line path wait 5 s
      const t0 = Date.now();
      const out = await confirmed(f, token);
      expect(Date.now() - t0).toBeLessThan(2_000);
      expect(out.refused).toEqual([{ txId: id, reason: expect.stringMatching(/reconciliation now holds it/) }]);
    } finally { await holder.query('ROLLBACK'); holder.release(); }
    await pool.query('UPDATE bank_transactions SET reconciliation_id = NULL WHERE id = $1', [id]);
    await pool.query('DELETE FROM bank_reconciliations WHERE id = $1', [rec]);
  }, 20_000);
});

describe('warnings', () => {
  it('W2: the token pins the amount and the date: a token whose amount no longer matches is refused', async () => {
    const f = await fixture();
    const id = await suggested(f, { amount: -100 });
    const row = (await pool.query("SELECT to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US') AS v FROM bank_transactions WHERE id = $1", [id])).rows[0];
    const tokenFor = (m: number, d: string) => Buffer.from(JSON.stringify({ v: 1, a: f.bank, t: 0.9, l: [{ i: id, g: f.expA, x: null, s: row.v, m, d }] })).toString('base64url');
    expect((await confirmed(f, tokenFor(-99, '2026-09-01'))).refused[0]!.reason).toMatch(/amount or date/);
    expect((await confirmed(f, tokenFor(-100, '2026-09-02'))).refused[0]!.reason).toMatch(/amount or date/);
    expect((await confirmed(f, tokenFor(-100, '2026-09-01'))).posted).toHaveLength(1);
  });

  it('W4: malformed tokens do not spend the confirm quota, and undo is rate limited', async () => {
    const f = await fixture();
    await suggested(f);
    for (let i = 0; i < 12; i += 1) expect((await post(f, { action: 'confirm', previewToken: 'garbage' })).state.statusCode).toBe(400);
    expect(dataOf<Confirmed>(await post(f, { action: 'confirm', previewToken: (await previewOf(f)).previewToken })).posted).toHaveLength(1);
    const statuses: number[] = [];
    for (let i = 0; i < 12; i += 1) statuses.push((await post(f, { action: 'undo', runId: crypto.randomUUID() })).state.statusCode);
    expect(statuses).toContain(429);
  });

  it('W5: a refusal is labelled by its code: an importer\'s own statement reads "needs a colleague"', async () => {
    const f = await fixture();
    await enforce(pool, f.c, a, ['manual_journal']);
    const batch = (await pool.query(
      `INSERT INTO bank_import_batches(company_id, bank_account_id, statement_date, transaction_count, imported_by, import_channel) VALUES($1,$2,DATE '2026-09-30',1,$3,'upload') RETURNING id`, [f.c, f.bank, a])).rows[0].id;
    const id = await suggested(f, { batch });
    const row = (await pool.query("SELECT to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US') AS v FROM bank_transactions WHERE id = $1", [id])).rows[0];
    const token = Buffer.from(JSON.stringify({ v: 1, a: f.bank, t: 0.9, l: [{ i: id, g: f.expA, x: null, s: row.v, m: -100, d: '2026-09-01' }] })).toString('base64url');
    const out = await confirmed(f, token);
    expect(out.posted).toHaveLength(0);
    expect(out.refused[0]!.reason).toMatch(/^needs a colleague: /);
  });
});
