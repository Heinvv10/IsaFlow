/** WP6 UI review: the lost-answer look-up offers only the CALLER's own un-undone batch on the account (never another person's). */
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

beforeAll(async () => { a = await createUser(pool, tokens); b = await createUser(pool, tokens); });
afterAll(async () => {
  await pool.query('UPDATE bank_transactions SET auto_post_run_id = NULL WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM bank_transactions WHERE company_id = ANY($1)', [companies]);
  await cleanupBankControlsA(pool, companies, [a, b]);
});

const lookup = async (f: BankCompany, user: string, account: string, since: number | string) => dataOf<{ batch: { id: string; postedCount: number } | null }>(
  await callRoute(bulkAccept, tokens[user]!, f.c, 'GET', undefined, URL, { bankAccountId: account, recentSince: String(since) }));

async function runBy(f: BankCompany, user: string, o: { undone?: boolean; posted?: number; withLine?: boolean } = {}) {
  const id = (await pool.query(
    `INSERT INTO bank_auto_post_runs(company_id, source, min_confidence, amount_cap, posted_count, total_amount, created_by, undone_at)
     VALUES($1,'manual',0.8,0,$2,10,$3,$4) RETURNING id::TEXT AS id`, [f.c, o.posted ?? 1, user, o.undone ? new Date() : null])).rows[0].id as string;
  if (o.withLine !== false) {
    await pool.query(
      `INSERT INTO bank_transactions(company_id, bank_account_id, transaction_date, amount, description, status, auto_post_run_id)
       VALUES($1,$2,DATE '2026-09-01',-1,'R5 line','allocated',$3)`, [f.c, f.bank, id]);
  }
  return id;
}

describe('findOwnRecentBatch through the route', () => {
  it('offers the caller\'s own batch, and not another member\'s in the same window', async () => {
    const f = await bankCompany(pool, [[a, 'admin'], [b, 'admin']], companies);
    const theirs = await runBy(f, b);
    expect((await lookup(f, a, f.bank, Date.now() - 60_000)).batch).toBeNull(); // only b's batch exists
    const mine = await runBy(f, a);
    const found = (await lookup(f, a, f.bank, Date.now() - 60_000)).batch;
    expect(found?.id).toBe(mine);
    expect(found?.id).not.toBe(theirs);
    expect((await lookup(f, b, f.bank, Date.now() - 60_000)).batch?.id).toBe(theirs); // and b sees only theirs
  });

  it('skips an undone batch, an empty one, one on another account, one before the window, and a run with no lines here', async () => {
    const f = await bankCompany(pool, [[a, 'admin'], [b, 'admin']], companies);
    await runBy(f, a, { undone: true });
    await runBy(f, a, { posted: 0 });
    await runBy(f, a, { withLine: false });
    expect((await lookup(f, a, f.bank, Date.now() - 60_000)).batch).toBeNull();
    const mine = await runBy(f, a);
    expect((await lookup(f, a, f.bank2, Date.now() - 60_000)).batch).toBeNull(); // another account of the company
    expect((await lookup(f, a, f.bank, Date.now() + 3_600_000)).batch).toBeNull(); // the window starts in the future
    expect((await lookup(f, a, f.bank, Date.now() - 60_000)).batch?.id).toBe(mine);
  });

  it('a bad recentSince is a 400', async () => {
    const f = await bankCompany(pool, [[a, 'admin']], companies);
    const res = await callRoute(bulkAccept, tokens[a]!, f.c, 'GET', undefined, URL, { bankAccountId: f.bank, recentSince: 'soon' });
    expect(res.state.statusCode).toBe(400);
  });
});
