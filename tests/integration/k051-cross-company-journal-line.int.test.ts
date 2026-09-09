/**
 * K-051 (round 5) — a journal line could name ANOTHER COMPANY's GL account.
 *
 * `gl_journal_lines_gl_account_id_fkey` references `gl_accounts(id)` alone, the
 * RLS `WITH CHECK` tests the LINE's company only, and RI checks bypass RLS — so
 * nothing in the database tied the two companies together.
 * `POST /api/accounting/journal-entries` passes caller-supplied `lines` into
 * `createJournalEntry`, which stamps `company_id` from the SESSION and
 * `gl_account_id` from the request body. `validateJournalEntry` is pure and sees
 * only debits and credits. So one request wrote a cross-tenant ledger row: the
 * other company's account acquires a balance visible through its own
 * `ga.company_id` joins, and this company's trial balance carries a line to an
 * account it does not own. `create_draft_journal` has always refused it; the
 * REST path did not.
 *
 * Two defences, both proved here: the ownership check in `createJournalEntry`,
 * and migration 660's composite FK, which makes the pair unrepresentable.
 *
 * The third test is why `assertParentUsable`'s posted-lines read carries
 * `company_id`: rows written BEFORE 660 can still hold that shape, and the
 * guard must judge this company's parent on this company's lines — the same
 * predicate `balanceSheetService` uses.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { als } from '../../src/lib/als';
import { getPoolForTests } from '../../src/lib/neon';
import { createJournalEntry } from '../../src/modules/accounting/services/gl/journalEntryCrudService';
import { assertParentUsable } from '../../src/modules/accounting/services/gl/accountParentRules';
import { getBalanceSheet } from '../../src/modules/accounting/services/reports/balanceSheetService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID(), user = crypto.randomUUID();
const otherCompany = crypto.randomUUID(), otherUser = crypto.randomUUID();
const own = crypto.randomUUID(), equity = crypto.randomUUID();
const foreign = crypto.randomUUID();
const scopeParent = crypto.randomUUID();
const AS_AT = '2026-03-31';
const FK = 'gl_journal_lines_account_company_fk';

/** The request transaction every production caller runs inside. */
async function inRequestTx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPoolForTests().connect();
  try {
    await client.query('BEGIN');
    const out = await als.run(
      { client, userId: user, companyId: company, claims: {} } as unknown as Parameters<typeof als.run>[0],
      () => fn(client),
    );
    await client.query('ROLLBACK');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally { client.release(); }
}

beforeAll(async () => {
  await pool.query("INSERT INTO companies(id,name) VALUES($1,'K051X own'),($2,'K051X other')",
    [company, otherCompany]);
  await pool.query(
    "INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true),($3,$4,'admin',true)",
    [user, `${user}@test.local`, otherUser, `${otherUser}@test.local`]);
  await pool.query(
    `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance,level,is_active)
     VALUES($1,$2,'K051X-1200','K051X Prepayments','asset','debit',3,true),
            ($3,$2,'K051X-3000','K051X Retained earnings','equity','credit',3,true),
            ($4,$2,'K051X-2100','K051X Deposits paid (level 2, empty)','asset','debit',2,true)`,
    [own, company, equity, scopeParent]);
  await pool.query(
    `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance,level,is_active)
     VALUES($1,$2,'K051X-1500','K051X Other tenant bank','asset','debit',3,true)`,
    [foreign, otherCompany]);
  await pool.query(
    `INSERT INTO fiscal_periods(company_id,period_name,period_number,fiscal_year,start_date,end_date,status)
     VALUES($1,'K051X Mar 2026',3,2026,'2026-03-01','2026-03-31','open')`, [company]);
});

afterAll(async () => {
  try {
    const ids = [company, otherCompany];
    await pool.query('DELETE FROM gl_journal_lines WHERE company_id=ANY($1)', [ids]);
    await pool.query('DELETE FROM gl_journal_entries WHERE company_id=ANY($1)', [ids]);
    await pool.query('DELETE FROM gl_account_balances WHERE gl_account_id IN (SELECT id FROM gl_accounts WHERE company_id=ANY($1))', [ids]);
    await pool.query('DELETE FROM gl_accounts WHERE company_id=ANY($1)', [ids]);
    await pool.query('DELETE FROM fiscal_periods WHERE company_id=ANY($1)', [ids]);
    await pool.query('DELETE FROM companies WHERE id=ANY($1)', [ids]);
    await pool.query('DELETE FROM users WHERE id=ANY($1)', [[user, otherUser]]);
  } finally { await pool.end(); }
});

it('refuses a journal whose line names another company GL account, and writes nothing', async () => {
  await expect(inRequestTx(() => createJournalEntry(
    company,
    {
      entryDate: '2026-03-15',
      description: 'K051X cross-tenant attempt',
      lines: [
        { glAccountId: foreign, debit: 900, credit: 0 },
        { glAccountId: equity, debit: 0, credit: 900 },
      ],
    },
    user,
  ))).rejects.toThrow(/outside this company/);

  // The entry row is refused BEFORE the insert, so neither company gained one.
  const { rows } = await pool.query(
    'SELECT COUNT(*)::int AS n FROM gl_journal_lines WHERE gl_account_id=$1', [foreign]);
  expect(rows[0].n).toBe(0);
});

it('still creates the journal when every line is this company own account', async () => {
  // The refusal must be about the FOREIGN account, not about journals.
  const entry = await inRequestTx(() => createJournalEntry(
    company,
    {
      entryDate: '2026-03-15',
      description: 'K051X control',
      lines: [
        { glAccountId: own, debit: 900, credit: 0 },
        { glAccountId: equity, debit: 0, credit: 900 },
      ],
    },
    user,
  ));
  expect(entry.id).toBeTruthy();
});

it('migration 660 refuses the pair at the storage layer too', async () => {
  // The service check is the message; the constraint is the guarantee. Every
  // other writer of gl_journal_lines is covered by this one whether or not it
  // remembers to ask.
  const { rows } = await pool.query(
    `INSERT INTO gl_journal_entries(company_id,entry_number,entry_date,source,status,created_by)
     VALUES($1,'K051X-JE-RAW','2026-03-15'::date,'manual','posted',$2) RETURNING id`,
    [company, user]);
  await expect(pool.query(
    'INSERT INTO gl_journal_lines(journal_entry_id,gl_account_id,debit,credit,company_id) VALUES($1,$2,$3,$4,$5)',
    [rows[0].id, foreign, 10, 0, company],
  )).rejects.toMatchObject({ code: '23503', constraint: FK });
});

it('judges a level-2 asset parent on THIS company lines only, and the balance sheet agrees', async () => {
  // The pre-660 shape, which historical rows can still hold: a line on THIS
  // company's account carrying ANOTHER company's `company_id`. 660 makes it
  // unrepresentable, so the row is written with `session_replication_role` set
  // to `replica` for this transaction only — which suppresses the FK trigger
  // without touching the schema — and the transaction is rolled back.
  //
  // `assertParentUsable` must ADMIT the child: its posted-lines read is scoped
  // by `company_id`, and `balanceSheetService` filters `jl.company_id`,
  // `ga.company_id` AND `je.company_id`, so the rand is on neither side of the
  // question. Drop the scope and the guard refuses a chart edit that loses
  // nothing.
  const { admitted, ownAssets } = await inRequestTx(async (client) => {
    await client.query("SET LOCAL session_replication_role = 'replica'");
    const { rows } = await client.query(
      `INSERT INTO gl_journal_entries(company_id,entry_number,entry_date,source,status,created_by,posted_at)
       VALUES($1,'K051X-JE-FOREIGN','2026-03-15'::date,'manual','posted',$2,NOW()) RETURNING id`,
      [otherCompany, otherUser]);
    await client.query(
      'INSERT INTO gl_journal_lines(journal_entry_id,gl_account_id,debit,credit,company_id) VALUES($1,$2,$3,$4,$5)',
      [rows[0].id, scopeParent, 4000, 0, otherCompany]);
    return {
      admitted: await assertParentUsable(company, scopeParent, 'asset'),
      ownAssets: (await getBalanceSheet(company, AS_AT)).totalAssets,
    };
  });

  expect(admitted).toEqual({ childLevel: 3 });
  // R4,000 of another tenant's money never reached this company's assets.
  expect(ownAssets).toBeCloseTo(0, 2);
});
