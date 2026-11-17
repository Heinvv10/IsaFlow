/**
 * WP6 UI review: the confirm is replay-safe under an Idempotency-Key. A resend after a lost answer replays the first answer
 * (the same runId, one batch, no second journal); a refusal frees the key; another user cannot take it; undo is unaffected.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import bulkAccept from '../../pages/api/accounting/bank-bulk-accept';
import bankTransactionsAction from '../../pages/api/accounting/bank-transactions-action';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser } from './r035-approval.helpers';
import { dataOf } from './r035-pr2.helpers';
import { bankCompany, cleanupBankControlsA, type BankCompany } from './bank-controls-a.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let a = '';
let b = '';
const URL = '/api/accounting/bank-bulk-accept';
const KEY1 = '11111111-aaaa-4aaa-8aaa-000000000001';
const KEY2 = '11111111-aaaa-4aaa-8aaa-000000000002';

beforeAll(async () => { a = await createUser(pool, tokens); b = await createUser(pool, tokens); });
afterAll(async () => {
  await pool.query('DELETE FROM http_idempotency_keys WHERE company_id = ANY($1)', [companies]);
  await pool.query('UPDATE bank_transactions SET auto_post_run_id = NULL WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM bank_transactions WHERE company_id = ANY($1)', [companies]);
  await cleanupBankControlsA(pool, companies, [a, b]);
});

async function fixture(): Promise<BankCompany> {
  const f = await bankCompany(pool, [[a, 'admin'], [b, 'admin']], companies);
  await pool.query(
    `INSERT INTO bank_auto_post_settings(company_id, enabled, min_confidence, amount_cap, llm_enabled, llm_min_confidence, llm_amount_cap)
     VALUES($1, true, 0.50, 0, false, 0.95, 0)`, [f.c]);
  await pool.query(
    `INSERT INTO bank_transactions(company_id, bank_account_id, transaction_date, amount, description, status, suggested_gl_account_id, suggested_confidence, suggested_strategy)
     SELECT $1, $2, DATE '2026-09-01', -g, 'R5 line', 'imported', $3, 0.97, 'history' FROM generate_series(1, 2) g`, [f.c, f.bank, f.expA]);
  return f;
}
const previewToken = async (f: BankCompany) => dataOf<{ previewToken: string }>(
  await callRoute(bulkAccept, tokens[a]!, f.c, 'GET', undefined, URL, { bankAccountId: f.bank })).previewToken;
const confirm = (f: BankCompany, token: string, key?: string, user = a) =>
  callRoute(bulkAccept, tokens[user]!, f.c, 'POST', { action: 'confirm', previewToken: token }, URL, {}, key ? { 'idempotency-key': key } : {});
const journals = async (c: string) => (await pool.query('SELECT COUNT(*)::INT AS n FROM gl_journal_entries WHERE company_id = $1', [c])).rows[0].n as number;
const runs = async (c: string) => (await pool.query("SELECT COUNT(*)::INT AS n FROM bank_auto_post_runs WHERE company_id = $1 AND source = 'manual'", [c])).rows[0].n as number;

describe('confirm under an Idempotency-Key', () => {
  it('a resend with the same key replays the first answer: the same runId, one batch, no second journal', async () => {
    const f = await fixture();
    const token = await previewToken(f);
    const first = await confirm(f, token, KEY1);
    expect(first.state.statusCode).toBe(200);
    const firstData = dataOf<{ runId: string; posted: unknown[] }>(first);
    expect(firstData.posted).toHaveLength(2);
    const second = await confirm(f, token, KEY1);
    expect(second.state.statusCode).toBe(200);
    expect(dataOf<{ runId: string }>(second).runId).toBe(firstData.runId);
    expect(await journals(f.c)).toBe(2);
    expect(await runs(f.c)).toBe(1);
  });

  it('without the key the same resend is not replayed (it posts nothing new, but is a fresh request)', async () => {
    const f = await fixture();
    const token = await previewToken(f);
    await confirm(f, token);
    const again = dataOf<{ runId: string | null; posted: unknown[] }>(await confirm(f, token));
    expect(again.posted).toHaveLength(0); // the lines are no longer imported
    expect(again.runId).toBeNull();
  });

  it('a different batch under a new key is its own request', async () => {
    const f = await fixture();
    const first = dataOf<{ runId: string }>(await confirm(f, await previewToken(f), KEY1));
    await pool.query(
      `INSERT INTO bank_transactions(company_id, bank_account_id, transaction_date, amount, description, status, suggested_gl_account_id, suggested_confidence, suggested_strategy)
       VALUES($1,$2,DATE '2026-09-02',-5,'R5 later','imported',$3,0.97,'history')`, [f.c, f.bank, f.expA]);
    const second = dataOf<{ runId: string }>(await confirm(f, await previewToken(f), KEY2));
    expect(second.runId).not.toBe(first.runId);
  });

  it('another user cannot take the key (422), and the key on a different token is refused', async () => {
    const f = await fixture();
    const token = await previewToken(f);
    await confirm(f, token, KEY1);
    expect((await confirm(f, token, KEY1, b)).state.statusCode).toBe(422);
    expect((await confirm(f, 'e30', KEY1)).state.statusCode).toBe(422);
  });

  it('a refusal frees the key: a bad token 400s, and the same key then works for the real confirm', async () => {
    const f = await fixture();
    expect((await confirm(f, 'not-a-token', KEY1)).state.statusCode).toBe(400);
    const ok = await confirm(f, await previewToken(f), KEY1);
    expect(ok.state.statusCode).toBe(200);
    expect(dataOf<{ posted: unknown[] }>(ok).posted).toHaveLength(2);
  });
});

describe('the claim race and undo under a key', () => {
  it('a same-key resend while the first claim is uncommitted waits, then 503s with Retry-After and leaves no stale claim', async () => {
    const f = await fixture();
    const token = await previewToken(f);
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      // The first request's claim: inserted, not yet committed (its handler still running).
      await holder.query(
        `INSERT INTO http_idempotency_keys (company_id, route, idempotency_key, payload_hash, created_by) VALUES ($1,'bank-bulk-accept',$2,'x',$3)`, [f.c, KEY1, a]);
      const t0 = Date.now();
      const second = await confirm(f, token, KEY1);
      expect(Date.now() - t0).toBeGreaterThanOrEqual(4_000); // it waited on the unique index (bound 5 s)
      expect(second.state.statusCode).toBe(503);
      expect(String((second as unknown as { headers: { get(n: string): unknown } }).headers.get('retry-after') ?? '')).not.toBe('');
      expect(await journals(f.c)).toBe(0);
    } finally { await holder.query('ROLLBACK'); holder.release(); }
    // The holder rolled back: nothing of the failed resend is left, and the same key now runs fresh.
    expect((await pool.query("SELECT COUNT(*)::INT AS n FROM http_idempotency_keys WHERE company_id = $1 AND idempotency_key = $2", [f.c, KEY1])).rows[0].n).toBe(0);
    const ok = await confirm(f, token, KEY1);
    expect(ok.state.statusCode).toBe(200);
    expect(dataOf<{ posted: unknown[] }>(ok).posted).toHaveLength(2);
  }, 30_000);

  it('two same-key confirms at once: one batch, both answers carry its runId', async () => {
    const f = await fixture();
    const token = await previewToken(f);
    const [x, y] = await Promise.all([confirm(f, token, KEY2), confirm(f, token, KEY2)]);
    expect([x.state.statusCode, y.state.statusCode].filter((c) => c === 200).length).toBeGreaterThanOrEqual(1);
    expect(await runs(f.c)).toBe(1);
    expect(await journals(f.c)).toBe(2);
    const ids = [x, y].filter((r) => r.state.statusCode === 200).map((r) => dataOf<{ runId: string }>(r).runId);
    expect(new Set(ids).size).toBe(1);
  }, 30_000);

  it('an undo under a key replays on a resend (not "already undone") and a different key after it is refused as undone', async () => {
    const f = await fixture();
    const run = dataOf<{ runId: string }>(await confirm(f, await previewToken(f)));
    const undo = (key: string) => callRoute(bulkAccept, tokens[a]!, f.c, 'POST', { action: 'undo', runId: run.runId }, URL, {}, { 'idempotency-key': key });
    const first = await undo(KEY1);
    expect(first.state.statusCode).toBe(200);
    expect(dataOf<{ undone: boolean }>(first).undone).toBe(true);
    const again = await undo(KEY1);
    expect(again.state.statusCode).toBe(200);
    expect(dataOf<{ undone: boolean }>(again).undone).toBe(true);
    expect((await undo(KEY2)).state.statusCode).toBe(400); // a new click on an undone batch is the honest refusal
  });
});

describe('an undo that meets a contended line and a changed-since-run line', () => {
  it('a lock timeout on one line answers a retryable failure; the resend ends in the right state (the contended line reversed, the changed one left alone)', async () => {
    const f = await fixture();
    const run = dataOf<{ runId: string; posted: { txId: string; journalEntryId: string }[] }>(await confirm(f, await previewToken(f)));
    const [first, second] = run.posted.map((p) => p.txId).sort();
    const act = (body: Record<string, unknown>) => callRoute(bankTransactionsAction, tokens[a]!, f.c, 'POST', body, '/api/accounting/bank-transactions-action');
    // The first line is re-coded by hand, then carries a stale tag again (a pre-999j residue): changedSinceRun.
    expect((await act({ action: 'reverse', bankTransactionId: first })).state.statusCode).toBe(200);
    expect((await act({ action: 'allocate', bankTransactionId: first, contraAccountId: f.expB })).state.statusCode).toBe(200);
    await pool.query('UPDATE bank_transactions SET auto_post_run_id = $2, auto_post_journal_id = $3 WHERE id = $1',
      [first, run.runId, run.posted.find((p) => p.txId === first)!.journalEntryId]);
    const undo = (key: string) => callRoute(bulkAccept, tokens[a]!, f.c, 'POST', { action: 'undo', runId: run.runId }, URL, {}, { 'idempotency-key': key });
    const tagOf = async (id: string) => (await pool.query('SELECT auto_post_run_id::TEXT AS t, status FROM bank_transactions WHERE id = $1', [id])).rows[0] as { t: string | null; status: string };

    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM bank_transactions WHERE id = $1 FOR UPDATE', [second]); // a peer holds the second line
      const blocked = await undo(KEY1);
      // The row lock times out (55P03): the undo re-throws it with nothing reversed, and the route maps a held row to 503 with
      // Retry-After (respondIfLockTimeout). A 5xx rolls the request back, so the changed line's untag did NOT commit either.
      expect(blocked.state.statusCode).toBe(503);
      expect((await tagOf(first)).t).toBe(run.runId);
      expect((await tagOf(second)).t).toBe(run.runId);
      expect((await tagOf(second)).status).toBe('allocated');
    } finally { await holder.query('ROLLBACK'); holder.release(); }

    const again = await undo(KEY1); // the same key: a 503 stored nothing, so it runs fresh
    expect(again.state.statusCode).toBe(200);
    // The contended line is reversed now; the changed line left the run (skipped, never reversed): the run closes on the next undo.
    expect(dataOf<{ reversed: number; skippedBy: { changedSinceRun: number } }>(again)).toMatchObject({ reversed: 1, skippedBy: { changedSinceRun: 1 } });
    expect((await tagOf(first)).t).toBeNull();
    expect((await tagOf(second)).t).toBeNull();
    expect((await tagOf(second)).status).toBe('imported');
    expect((await tagOf(first)).status).toBe('allocated'); // the hand re-coding stands
    expect(dataOf<{ undone: boolean }>(await undo(KEY2)).undone).toBe(true); // and the run now closes
  }, 40_000);
});
