/**
 * WP3 against real Postgres, through the real routes: the amount filter compares the SIZE of a line (a payment and a
 * receipt of the same size both match), a non-numeric bound is a 400, % and _ in the search are literal, and update_notes
 * on a line that is not this company's is a 404 (and writes nothing).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser } from './r035-approval.helpers';
import { journalCompany } from './r035-pr6.helpers';
import { bankCompany, cleanupBankControlsA, plantBatch, type BankCompany } from './bank-controls-a.helpers';
import listRoute from '../../pages/api/accounting/bank-transactions';
import actionRoute from '../../pages/api/accounting/bank-transactions-action';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let user: string, f: BankCompany, g: Awaited<ReturnType<typeof journalCompany>>;
const ids: Record<string, string> = {};

const put = async (desc: string, amount: number, batch: string): Promise<string> => (await pool.query(
  `INSERT INTO bank_transactions(company_id, bank_account_id, transaction_date, amount, description, status, import_batch_id)
   VALUES($1,$2,DATE '2026-09-01',$3,$4,'imported',$5) RETURNING id`, [f.c, f.bank, amount, desc, batch])).rows[0].id as string;
const list = (query: Record<string, string>) => callRoute(listRoute as never, tokens[user]!, f.c, 'GET', undefined, '/api/accounting/bank-transactions',
  { bank_account_id: f.bank, status: 'imported', ...query });
const descs = (r: Awaited<ReturnType<typeof list>>) => (r.state.body as { data: { transactions: Array<{ description: string }> } }).data.transactions.map((t) => t.description).sort();

beforeAll(async () => {
  user = await createUser(pool, tokens);
  f = await bankCompany(pool, [[user, 'admin']], companies);
  g = await journalCompany(pool, [[user, 'admin']], companies);
  const batch = await plantBatch(pool, f, user);
  for (const [k, d, a] of [['pay150', 'WP3 pay 150', -150], ['rec150', 'WP3 rec 150', 150], ['pay30', 'WP3 pay 30', -30], ['pct', 'WP3 100% done', -10], ['plain', 'WP3 100 done', -10], ['us', 'WP3 a_b', -10], ['ab', 'WP3 axb', -10]] as const) {
    ids[k] = await put(d, a, batch);
  }
});
afterAll(async () => { await cleanupBankControlsA(pool, companies, [user]); });

describe('amount filter', () => {
  it('Min R100 / Max R200 finds the R150 payment AND the R150 receipt, not the R30 one', async () => {
    const r = await list({ from_amount: '100', to_amount: '200' });
    expect(r.state.statusCode).toBe(200);
    expect(descs(r)).toEqual(['WP3 pay 150', 'WP3 rec 150']);
  });
  it('the total counts the same set (ABS in the COUNT too)', async () => {
    const r = await list({ from_amount: '100', to_amount: '200' });
    expect((r.state.body as { data: { total: number } }).data.total).toBe(2);
  });
  it('Min R100 alone excludes only the small ones', async () => {
    expect(descs(await list({ from_amount: '100' }))).toEqual(['WP3 pay 150', 'WP3 rec 150']);
  });
  it('a non-numeric bound is a 400, not a 500', async () => {
    for (const bad of ['abc', '1;DROP', '1e5']) {
      expect((await list({ from_amount: bad })).state.statusCode, bad).toBe(400);
      expect((await list({ to_amount: bad })).state.statusCode, bad).toBe(400);
    }
  });
});

describe('search', () => {
  it('"100%" matches only the line that contains a percent sign (it was a wildcard: "100" + anything)', async () => {
    expect(descs(await list({ search: '100%' }))).toEqual(['WP3 100% done']);
  });
  it('"a_b" matches only the underscore line, not "axb"', async () => {
    expect(descs(await list({ search: 'a_b' }))).toEqual(['WP3 a_b']);
  });
  it('plain text still finds every containing line', async () => {
    expect(descs(await list({ search: '100' })).sort()).toEqual(['WP3 100 done', 'WP3 100% done']);
  });
});

describe('update_notes', () => {
  const note = (id: string, company = f.c) => callRoute(actionRoute as never, tokens[user]!, company, 'POST',
    { action: 'update_notes', bankTransactionId: id, notes: 'checked' }, '/api/accounting/bank-transactions-action');
  const stored = async (id: string) => (await pool.query('SELECT notes FROM bank_transactions WHERE id = $1', [id])).rows[0]?.notes ?? null;

  it('saves a note on the company\'s own line', async () => {
    expect((await note(ids.pay150!)).state.statusCode).toBe(200);
    expect(await stored(ids.pay150!)).toBe('checked');
  });
  it('a line that is not this company\'s (another tenant, or no such id) is a 404 and writes nothing', async () => {
    expect((await note(ids.pay30!, g.c)).state.statusCode).toBe(404); // the user is a member of g too, but the line is f's
    expect(await stored(ids.pay30!)).toBeNull();
    expect((await note(crypto.randomUUID())).state.statusCode).toBe(404);
  });
});
