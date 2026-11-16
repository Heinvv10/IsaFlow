/**
 * Audit WP6 (Hein decision 2a.2), the API half: preview high-confidence suggestions, confirm them in ONE request,
 * undo exactly that batch. Rows decide by outcome; a line changed since the preview is refused, never posted stale.
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
let viewer = '';
const URL = '/api/accounting/bank-bulk-accept';

beforeAll(async () => { a = await createUser(pool, tokens); viewer = await createUser(pool, tokens); });
afterAll(async () => {
  await pool.query('UPDATE bank_transactions SET auto_post_run_id = NULL WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM bank_transactions WHERE company_id = ANY($1)', [companies]);
  await cleanupBankControlsA(pool, companies, [a, viewer]); // ends the pool
});

async function fixture(): Promise<BankCompany> {
  const f = await bankCompany(pool, [[a, 'admin'], [viewer, 'viewer']], companies);
  await pool.query(
    `INSERT INTO bank_auto_post_settings(company_id, enabled, min_confidence, amount_cap, llm_enabled, llm_min_confidence, llm_amount_cap)
     VALUES($1, false, 0.90, 0, false, 0.95, 0)`, [f.c]);
  return f;
}
/** An imported line carrying a suggestion. */
async function suggested(f: BankCompany, o: { amount?: number; confidence?: number; strategy?: string; date?: string; bank?: string; gl?: string } = {}) {
  return (await pool.query(
    `INSERT INTO bank_transactions(company_id, bank_account_id, transaction_date, amount, description, status,
       suggested_gl_account_id, suggested_confidence, suggested_strategy)
     VALUES($1,$2,$3,$4,'BULK line','imported',$5,$6,$7) RETURNING id`,
    [f.c, o.bank ?? f.bank, o.date ?? '2026-09-01', o.amount ?? -100, o.gl ?? f.expA, o.confidence ?? 0.97, o.strategy ?? 'history'])).rows[0].id as string;
}
const preview = (f: BankCompany, query: Record<string, string> = {}, user = a) => callRoute(bulkAccept, tokens[user]!, f.c, 'GET', undefined, URL,
  { bankAccountId: f.bank, ...query });
const post = (f: BankCompany, body: Record<string, unknown>, user = a) => callRoute(bulkAccept, tokens[user]!, f.c, 'POST', body, URL);
type Confirmed = { runId: string | null; posted: { txId: string; journalEntryId: string }[]; refused: { txId: string; reason: string }[] };
const confirm = async (f: BankCompany, token: string) => post(f, { action: 'confirm', previewToken: token });
const tokenOf = (res: Awaited<ReturnType<typeof preview>>) => dataOf<{ previewToken: string }>(res).previewToken;
const statusOf = async (id: string) => (await pool.query('SELECT status, auto_post_run_id FROM bank_transactions WHERE id = $1', [id])).rows[0] as { status: string; auto_post_run_id: string | null };
const journals = async (c: string) => (await pool.query('SELECT COUNT(*)::INT AS n FROM gl_journal_entries WHERE company_id = $1', [c])).rows[0].n as number;

describe('preview', () => {
  it('lists only high-confidence, imported, unshared lines of the account, with totals and a by-account breakdown', async () => {
    const f = await fixture();
    const ids = [await suggested(f, { amount: -100 }), await suggested(f, { amount: 250 }), await suggested(f, { amount: -50, gl: f.expB })];
    await suggested(f, { confidence: 0.5 });                       // below the floor
    await suggested(f, { strategy: 'shared_pool' });                // never bulk-posted
    await pool.query("UPDATE bank_transactions SET status = 'excluded' WHERE id = $1", [await suggested(f)]);
    await suggested(f, { bank: f.bank2 });                          // another bank account
    const res = await preview(f);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    const data = dataOf<{ lines: { id: string }[]; totalIn: number; totalOut: number; byAccount: { glAccountId: string; count: number }[]; truncated: boolean }>(res);
    expect(data.lines.map((l) => l.id).sort()).toEqual([...ids].sort());
    expect({ totalIn: data.totalIn, totalOut: data.totalOut, truncated: data.truncated }).toEqual({ totalIn: 250, totalOut: 150, truncated: false });
    expect(data.byAccount.map((g) => [g.glAccountId, g.count]).sort()).toEqual([[f.expA, 2], [f.expB, 1]].sort());
  });

  it('refuses another company\'s bank account, a missing one, and a viewer; caps a preview at 100 lines', async () => {
    const f = await fixture();
    const g = await fixture();
    expect((await preview(f, { bankAccountId: g.bank })).state.statusCode).toBe(400);
    expect((await preview(f, { bankAccountId: 'nope' })).state.statusCode).toBe(400);
    expect((await post(f, { action: 'confirm', previewToken: tokenOf(await preview(f)) }, viewer)).state.statusCode).toBe(403);
    await pool.query(
      `INSERT INTO bank_transactions(company_id, bank_account_id, transaction_date, amount, description, status, suggested_gl_account_id, suggested_confidence, suggested_strategy)
       SELECT $1,$2,DATE '2026-09-01',-1,'BULK many','imported',$3,0.97,'history' FROM generate_series(1,101)`, [f.c, f.bank, f.expA]);
    const data = dataOf<{ lines: unknown[]; truncated: boolean; totalEligibleAtLeast: number }>(await preview(f));
    expect({ n: data.lines.length, truncated: data.truncated, eligible: data.totalEligibleAtLeast }).toEqual({ n: 100, truncated: true, eligible: 101 });
  });
});

describe('confirm', () => {
  it('N lines give N balanced journals, tagged to one batch', async () => {
    const f = await fixture();
    const ids = [await suggested(f, { amount: -100 }), await suggested(f, { amount: 250 }), await suggested(f, { amount: -75.5 }), await suggested(f, { amount: -10 })];
    const res = await confirm(f, tokenOf(await preview(f)));
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    const out = dataOf<Confirmed>(res);
    expect({ posted: out.posted.length, refused: out.refused.length }).toEqual({ posted: 4, refused: 0 });
    const balanced = await pool.query(
      `SELECT je.id, SUM(l.debit) AS d, SUM(l.credit) AS c FROM gl_journal_entries je JOIN gl_journal_lines l ON l.journal_entry_id = je.id
       WHERE je.company_id = $1 GROUP BY je.id`, [f.c]);
    expect(balanced.rows).toHaveLength(4);
    for (const r of balanced.rows) expect(Number(r.d)).toBe(Number(r.c));
    for (const id of ids) expect(await statusOf(id)).toEqual({ status: 'allocated', auto_post_run_id: out.runId });
    const run = (await pool.query('SELECT source, posted_count, total_amount::FLOAT AS total FROM bank_auto_post_runs WHERE id = $1', [out.runId])).rows[0];
    expect(run).toEqual({ source: 'manual', posted_count: 4, total: 435.5 });
  });

  it('a refused line does not poison the rest: it is reported with its reason and the others post', async () => {
    const f = await fixture();
    const good = [await suggested(f), await suggested(f, { amount: -20 })];
    const dead = (await pool.query(
      `INSERT INTO gl_accounts(company_id,account_code,account_name,account_type,normal_balance,is_active) VALUES($1,'ZZDEAD','Retired','expense','debit',false) RETURNING id`, [f.c])).rows[0].id;
    const bad = await suggested(f, { gl: dead });
    const after = await suggested(f, { amount: -30 });
    await pool.query('UPDATE gl_accounts SET is_active = true WHERE id = $1', [dead]);
    const token = tokenOf(await preview(f));                         // previewed while the account was active ...
    await pool.query('UPDATE gl_accounts SET is_active = false WHERE id = $1', [dead]); // ... retired before the confirm
    const out = dataOf<Confirmed>(await confirm(f, token));
    expect(out.posted.map((p) => p.txId).sort()).toEqual([...good, after].sort());
    expect(out.refused).toHaveLength(1);
    expect(out.refused[0]!.txId).toBe(bad);
    expect(out.refused[0]!.reason.length).toBeGreaterThan(0);
    expect((await statusOf(bad)).status).toBe('imported');
    expect(await journals(f.c)).toBe(3);
  });

  it('a line changed between preview and confirm is refused, not posted stale', async () => {
    const f = await fixture();
    const [suggestionChanged, statusChanged, edited, untouched] = [await suggested(f), await suggested(f), await suggested(f), await suggested(f)];
    const token = tokenOf(await preview(f));
    await pool.query('UPDATE bank_transactions SET suggested_gl_account_id = $2 WHERE id = $1', [suggestionChanged, f.expB]);
    await pool.query("UPDATE bank_transactions SET status = 'excluded' WHERE id = $1", [statusChanged]);
    await pool.query("UPDATE bank_transactions SET description = 'edited since' WHERE id = $1", [edited]);
    const out = dataOf<Confirmed>(await confirm(f, token));
    expect(out.posted.map((p) => p.txId)).toEqual([untouched]);
    expect(out.refused.map((r) => r.txId).sort()).toEqual([suggestionChanged, statusChanged, edited].sort());
    for (const r of out.refused) expect(r.reason).toMatch(/changed since the preview/);
    expect(out.refused.find((r) => r.txId === statusChanged)!.reason).toMatch(/it is now excluded/);
    expect(await journals(f.c)).toBe(1);
  });

  it('a forged, malformed or oversized token is a 400 and posts nothing', async () => {
    const f = await fixture();
    await suggested(f);
    expect((await confirm(f, 'not a token')).state.statusCode).toBe(400);
    const forged = Buffer.from(JSON.stringify({ v: 1, a: f.bank, t: 0.9, l: [{ i: crypto.randomUUID(), g: f.expA, x: null, s: 'x', m: -1, d: '2026-09-01' }] })).toString('base64url');
    const res = await confirm(f, forged); // names a line that does not exist: refused as a row, nothing posted
    expect(dataOf<Confirmed>(res).posted).toHaveLength(0);
    const many = Buffer.from(JSON.stringify({ v: 1, a: f.bank, t: 0.9,
      l: Array.from({ length: 101 }, () => ({ i: crypto.randomUUID(), g: f.expA, x: null, s: 'x', m: -1, d: '2026-09-01' })) })).toString('base64url');
    expect((await confirm(f, many)).state.statusCode).toBe(400);
    expect(await journals(f.c)).toBe(0);
  });

  it('two concurrent confirms of the same preview post each line once', async () => {
    const f = await fixture();
    for (let i = 0; i < 5; i += 1) await suggested(f, { amount: -10 - i });
    const token = tokenOf(await preview(f));
    const started = Date.now();
    const [x, y] = await Promise.all([confirm(f, token), confirm(f, token)]);
    const postedBy = [x, y].map((r) => (r.state.statusCode === 200 ? dataOf<Confirmed>(r).posted.length : 0));
    expect(postedBy.reduce((s, n) => s + n, 0)).toBe(5);
    expect(await journals(f.c)).toBe(5);
    expect([x.state.statusCode, y.state.statusCode].sort()).toContain(200);
    expect(Date.now() - started).toBeLessThan(15_000); // the loser is turned away at once, not queued behind row locks
  }, 30_000);
});

describe('one confirm at a time per bank account', () => {
  it('while another confirm holds the account\'s lock, a confirm is turned away 409 at once and posts nothing; afterwards it posts', async () => {
    const f = await fixture();
    for (let i = 0; i < 3; i += 1) await suggested(f, { amount: -10 - i });
    const token = tokenOf(await preview(f));
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`bulk-accept:${f.c}:${f.bank}`]);
      const t0 = Date.now();
      const res = await confirm(f, token);
      expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(409);
      expect(Date.now() - t0).toBeLessThan(3_000);
      expect(await journals(f.c)).toBe(0);
    } finally { await holder.query('ROLLBACK'); holder.release(); }
    expect(dataOf<Confirmed>(await confirm(f, token)).posted).toHaveLength(3);
  });
});

describe('undo batch', () => {
  async function confirmed(f: BankCompany, n = 3) {
    const ids: string[] = [];
    for (let i = 0; i < n; i += 1) ids.push(await suggested(f, { amount: -100 - i }));
    const out = dataOf<Confirmed>(await confirm(f, tokenOf(await preview(f))));
    return { ids, runId: out.runId! };
  }
  const reversals = async (c: string) => (await pool.query(
    "SELECT COUNT(*)::INT AS n FROM gl_journal_entries WHERE company_id = $1 AND reversal_of_id IS NOT NULL", [c])).rows[0].n as number;

  it('reverses every journal of that batch, restores every line, and repeating it is refused', async () => {
    const f = await fixture();
    const other = await suggested(f, { amount: -7, confidence: 0.5 }); // not in the batch: stays
    const { ids, runId } = await confirmed(f);
    const res = await post(f, { action: 'undo', runId });
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    expect(dataOf<{ reversed: number; undone: boolean }>(res)).toMatchObject({ reversed: 3, undone: true });
    expect(await reversals(f.c)).toBe(3);
    for (const id of ids) expect(await statusOf(id)).toEqual({ status: 'imported', auto_post_run_id: null });
    expect((await statusOf(other)).status).toBe('imported');
    expect((await post(f, { action: 'undo', runId })).state.statusCode).toBe(400);
    expect(await reversals(f.c)).toBe(3);
  });

  it('two concurrent undos reverse each journal once', async () => {
    const f = await fixture();
    const { runId } = await confirmed(f);
    await Promise.all([post(f, { action: 'undo', runId }), post(f, { action: 'undo', runId })]);
    expect(await reversals(f.c)).toBe(3);
  }, 30_000);

  it('only a bulk-accept batch can be undone here; an unknown batch is a 404', async () => {
    const f = await fixture();
    const run = (await pool.query(
      `INSERT INTO bank_auto_post_runs(company_id, source, min_confidence, amount_cap) VALUES($1,'categorization',0.9,0) RETURNING id`, [f.c])).rows[0].id;
    expect((await post(f, { action: 'undo', runId: run })).state.statusCode).toBe(400);
    expect((await post(f, { action: 'undo', runId: crypto.randomUUID() })).state.statusCode).toBe(404);
  });
});
