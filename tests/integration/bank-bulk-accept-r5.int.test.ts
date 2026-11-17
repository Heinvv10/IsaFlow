/**
 * WP6 UI review: the confirm is replay-safe under an Idempotency-Key. A resend after a lost answer replays the first answer
 * (the same runId, one batch, no second journal); a refusal frees the key; another user cannot take it; undo is unaffected.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import bulkAccept from '../../pages/api/accounting/bank-bulk-accept';
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
