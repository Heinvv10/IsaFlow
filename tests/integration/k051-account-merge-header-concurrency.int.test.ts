/**
 * K-051 / K-052 — the two ROW LOCKS that make the header guards hold, proved
 * with two connections against a real Postgres.
 *
 * Split out of `k051-account-merge-into-header-hides-balance.int.test.ts`,
 * which passed the 300-line ceiling `CLAUDE.md` sets for all code. The verdict
 * tests stay there; what lives here is the concurrency, which needs its own
 * fixture (an EMPTY level-2 asset parent, and a childless level-2 target with a
 * source that carries a line) and a second connection in every case.
 *
 * Two directions, and both are needed:
 *  - `assertParentUsable` locks the PARENT before its posted-lines read, so a
 *    reclassification that posts the parent's first lines cannot commit inside
 *    the window between that verdict and the INSERT that acts on it.
 *  - `mergeAccounts` locks the TARGET, and `gl_accounts_parent_account_id_fkey`
 *    means a concurrent chart edit naming that target takes FOR KEY SHARE on
 *    the same row — which FOR UPDATE conflicts with. That is why the merge
 *    guard needs no post-write re-read.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { als } from '../../src/lib/als';
import { getPoolForTests } from '../../src/lib/neon';
import { assertParentUsable } from '../../src/modules/accounting/services/gl/accountParentRules';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID(), user = crypto.randomUUID();
const equity = crypto.randomUUID();
const postedExpenseParent = crypto.randomUUID(), postedAssetParent = crypto.randomUUID();
const scopeParent = crypto.randomUUID();
const raceTarget = crypto.randomUUID(), raceSource = crypto.randomUUID();
const raceIntruder = crypto.randomUUID();

async function postJournal(entryNumber: string, legs: [string, number, number][]) {
  const { rows } = await pool.query(
    `INSERT INTO gl_journal_entries(company_id,entry_number,entry_date,description,source,status,created_by,posted_at)
     VALUES($1,$2,'2026-03-15'::date,$3,'manual','posted',$4,NOW()) RETURNING id`,
    [company, entryNumber, entryNumber, user]);
  for (const [account, debit, credit] of legs) {
    await pool.query(
      'INSERT INTO gl_journal_lines(journal_entry_id,gl_account_id,debit,credit,company_id) VALUES($1,$2,$3,$4,$5)',
      [rows[0].id, account, debit, credit, company]);
  }
}

beforeAll(async () => {
  await pool.query("INSERT INTO companies(id,name) VALUES($1,'K051 lock fixture')", [company]);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)",
    [user, `${user}@test.local`]);
  await pool.query(
    `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance,level,is_active,parent_account_id)
     VALUES($1,$2,'K051L-3000','K051L Retained earnings','equity','credit',3,true,NULL),
            ($3,$2,'K051L-6700','K051L Admin expenses (posted, level 2)','expense','debit',2,true,NULL),
            ($4,$2,'K051L-2100','K051L Deposits paid (posted, level 2)','asset','debit',2,true,NULL),
            ($5,$2,'K051L-2200','K051L Rent deposits (unposted, level 2)','asset','debit',2,true,NULL),
            ($6,$2,'K051L-1900','K051L Bonds (level 2 leaf)','asset','debit',2,true,NULL),
            ($7,$2,'K051L-1950','K051L Bond deposits','asset','debit',3,true,NULL)`,
    [equity, company, postedExpenseParent, postedAssetParent, scopeParent, raceTarget, raceSource]);
  await pool.query(
    `INSERT INTO fiscal_periods(company_id,period_name,period_number,fiscal_year,start_date,end_date,status)
     VALUES($1,'K051L Mar 2026',3,2026,'2026-03-01','2026-03-31','open')`, [company]);
  await postJournal('K051L-JE-RACE', [[raceSource, 60, 0], [equity, 0, 60]]);
  await postJournal('K051L-JE-PARENTS',
    [[postedExpenseParent, 110, 0], [postedAssetParent, 130, 0], [equity, 0, 240]]);
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM gl_journal_lines WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_journal_entries WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_account_balances WHERE gl_account_id IN (SELECT id FROM gl_accounts WHERE company_id=$1)', [company]);
    await pool.query('UPDATE gl_accounts SET parent_account_id=NULL WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_accounts WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM fiscal_periods WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=$1', [company]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

/**
 * `assertParentUsable` locks a leaf-rule parent before its posted-lines read,
 * so it needs the request transaction `withAuth` and the MCP bearer pipeline
 * supply in production.
 */
async function parentCheck(parentId: string, childType: string) {
  const client = await getPoolForTests().connect();
  try {
    await client.query('BEGIN');
    const result = await als.run(
      { client, userId: user, companyId: company, claims: {} } as unknown as Parameters<typeof als.run>[0],
      () => assertParentUsable(company, parentId, childType),
    );
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally { (client as PoolClient).release(); }
}

it('lets a posted level-2 EXPENSE parent take a child, and refuses the asset one', async () => {
  // `assertParentUsable` guards the third write path — createAccount and
  // reclassifyAccount. It carried the same false reason the merge guard did.
  await expect(parentCheck(postedExpenseParent, 'expense'))
    .resolves.toEqual({ childLevel: 3 });
  await expect(parentCheck(postedAssetParent, 'asset'))
    .rejects.toThrow(/journal lines posted to it/);
});

it('refuses a parent whose first lines land while the create waits', async () => {
  // The race the parent lock closes, run in the order the guard cannot control.
  // A holds FOR UPDATE on the empty parent and posts its first line; B's
  // createAccount check starts inside that window. Before the lock, B read zero
  // posted lines, waited only at its INSERT, and then attached a child to an
  // account that by then carried a balance — the level-2 asset header this
  // guard exists to refuse. Now B waits at the lock and reads the settled row.
  const holder = await getPoolForTests().connect();
  let verdict: Promise<unknown>;
  try {
    await holder.query('BEGIN');
    await als.run(
      { client: holder, userId: user, companyId: company, claims: {} } as unknown as Parameters<typeof als.run>[0],
      async () => {
        const { lockGlAccountsForUpdate } = await import(
          '../../src/modules/accounting/services/gl/glAccountLock');
        await lockGlAccountsForUpdate(company, [scopeParent]);
      },
    );
    const { rows } = await holder.query(
      `INSERT INTO gl_journal_entries(company_id,entry_number,entry_date,description,source,status,created_by,posted_at)
       VALUES($1,'K051L-JE-LATE','2026-03-15'::date,'K051L late posting','manual','posted',$2,NOW()) RETURNING id`,
      [company, user]);
    await holder.query(
      'INSERT INTO gl_journal_lines(journal_entry_id,gl_account_id,debit,credit,company_id) VALUES($1,$2,$3,$4,$5)',
      [rows[0].id, scopeParent, 75, 0, company]);
    // B starts while A still holds the row: it must block, not decide.
    verdict = parentCheck(scopeParent, 'asset');
    // And it must STILL be blocked when A commits — otherwise B would be
    // reading the settled row by luck and the assertion below would hold with
    // no lock in the code at all.
    const raced = await Promise.race([
      verdict.then(() => 'settled', () => 'settled'),
      new Promise((resolve) => { setTimeout(() => resolve('blocked'), 150); }),
    ]);
    expect(raced).toBe('blocked');
    await holder.query('COMMIT');
  } catch (err) {
    await holder.query('ROLLBACK');
    throw err;
  } finally { (holder as PoolClient).release(); }

  await expect(verdict).rejects.toThrow(/journal lines posted to it/);
});


/** Runs `stmt` on its own connection with a 1s lock_timeout; resolves the SQLSTATE. */
async function withOneSecondLockTimeout(stmt: string, values: unknown[]): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '1s'");
    await client.query(stmt, values);
    await client.query('ROLLBACK');
    return 'committed';
  } catch (err) {
    await client.query('ROLLBACK');
    return String((err as { code?: string }).code);
  } finally { client.release(); }
}

it("the merge's row lock blocks a concurrent chart edit onto the target", async () => {
  // `lockGlAccountsForUpdate` is described as locking two ROWS, which reads as
  // if a concurrent `createAccount` or `reclassifyAccount` could still parent a
  // third account onto the target between the guard read and the merge's write.
  // It cannot: `gl_accounts_parent_account_id_fkey` references gl_accounts(id),
  // so both statements take FOR KEY SHARE on the target row and FOR UPDATE
  // conflicts with it. That is why the guard needs no post-write re-read.
  const holder = await pool.connect();
  try {
    await holder.query('BEGIN');
    await holder.query('SELECT id FROM gl_accounts WHERE id=$1 AND company_id=$2 FOR UPDATE',
      [raceTarget, company]);

    // createAccount's INSERT.
    expect(await withOneSecondLockTimeout(
      `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance,level,is_active,parent_account_id)
       VALUES($1,$2,'K051L-1910','K051L Bonds - detail','asset','debit',3,true,$3)`,
      [raceIntruder, company, raceTarget],
    )).toBe('55P03');

    // reclassifyAccount's reparent of an EXISTING account.
    expect(await withOneSecondLockTimeout(
      'UPDATE gl_accounts SET parent_account_id=$1 WHERE id=$2 AND company_id=$3',
      [raceTarget, raceSource, company],
    )).toBe('55P03');
  } finally {
    await holder.query('ROLLBACK');
    holder.release();
  }

  // Nothing was written by either attempt.
  const { rows } = await pool.query(
    'SELECT COUNT(*)::int AS n FROM gl_accounts WHERE parent_account_id=$1 AND company_id=$2',
    [raceTarget, company]);
  expect(rows[0].n).toBe(0);
});
