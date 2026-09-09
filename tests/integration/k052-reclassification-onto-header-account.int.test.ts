/**
 * K-052 — reclassification admits a target that is a parent HEADER account.
 *
 * admitReclassification (reclassification/planGuards.ts:84-160) checks
 * ownership, activity, the posting date's period, the VAT201 subtypes and the
 * VAT lock, but never asks whether the target is a leaf. Nothing downstream asks
 * either — `level` and `parent_account_id` appear nowhere in
 * src/modules/accounting/services/gl/reclassification/. balanceSheetService.ts:120-128
 * selects an account only when `level >= 3 OR it has no children`, so lines
 * moved onto a level <= 2 account that has children leave the balance sheet.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import { als } from '../../src/lib/als';
import { getPoolForTests } from '../../src/lib/neon';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { admitReclassification } from '../../src/modules/accounting/services/gl/reclassification/planGuards';
import { isRefusal } from '../../src/modules/accounting/services/gl/reclassification/planGuards';
import { getBalanceSheet } from '../../src/modules/accounting/services/reports/balanceSheetService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID(), user = crypto.randomUUID();
const header = crypto.randomUUID(), headerChild = crypto.randomUUID();
const source = crypto.randomUUID(), equity = crypto.randomUUID();
const otherCompany = crypto.randomUUID();
const flatLeaf = crypto.randomUUID(), foreignChild = crypto.randomUUID();
const deepParent = crypto.randomUUID(), deepParentChild = crypto.randomUUID();
const expenseHeader = crypto.randomUUID(), expenseHeaderChild = crypto.randomUUID();
const nullLevel = crypto.randomUUID(), nullLevelChild = crypto.randomUUID();
const raceTarget = crypto.randomUUID(), raceIntruder = crypto.randomUUID();
const AS_AT = '2026-03-31';

/**
 * The WRITE path: the guard takes `FOR UPDATE` on a leaf-rule target, which
 * needs a request transaction — `withAuth` supplies one in production,
 * `als.run` here.
 */
async function admit(sourceAccountId: string, targetAccountId: string, companyId = company) {
  const client = await getPoolForTests().connect();
  try {
    await client.query('BEGIN');
    const result = await als.run(
      { client, userId: user, companyId, claims: {} } as unknown as Parameters<typeof als.run>[0],
      () => admitReclassification({
        companyId, sourceAccountId, targetAccountId,
        from: null, to: null, postingDate: '2026-03-31', lockCandidateLines: true,
      }),
    );
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally { (client as PoolClient).release(); }
}

/**
 * The same guard with NO request transaction, which is the instrument that can
 * see whether it locked: `lockGlAccountsForUpdate` throws outside one. A
 * preview must reach a verdict here, and so must a write path whose target the
 * leaf rule cannot bite.
 */
function admitWithoutTransaction(
  targetAccountId: string, lockCandidateLines: boolean,
) {
  return admitReclassification({
    companyId: company, sourceAccountId: source, targetAccountId,
    from: null, to: null, postingDate: '2026-03-31', lockCandidateLines,
  });
}

beforeAll(async () => {
  await pool.query("INSERT INTO companies(id,name) VALUES($1,'K052 reclass fixture')", [company]);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await pool.query(
    `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance,level,is_active,parent_account_id)
     VALUES($1,$2,'K052-1100','K052 Receivables (header)','asset','debit',2,true,NULL),
            ($3,$2,'K052-1110','K052 Receivables detail','asset','debit',3,true,$1),
            ($4,$2,'K052-1200','K052 Prepayments','asset','debit',3,true,NULL),
            ($5,$2,'K052-3000','K052 Retained earnings','equity','credit',3,true,NULL),
            ($6,$2,'K052-1300','K052 Loans (level 1 leaf)','asset','debit',1,true,NULL),
            ($7,$2,'K052-1400','K052 Motor vehicles','asset','debit',3,true,NULL),
            ($8,$2,'K052-1410','K052 Motor vehicles - bakkies','asset','debit',4,true,$7),
            ($9,$2,'K052-6000','K052 Motor expenses (header)','expense','debit',2,true,NULL),
            ($10,$2,'K052-6010','K052 Fuel','expense','debit',3,true,$9)`,
    [header, company, headerChild, source, equity, flatLeaf,
      deepParent, deepParentChild, expenseHeader, expenseHeaderChild]);
  // `gl_accounts.level` is nullable with a default, so a row can carry NULL.
  // The refusal must read "level 1", not "level NaN".
  await pool.query(
    `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance,level,is_active,parent_account_id)
     VALUES($1,$2,'K052-1500','K052 Suspense (no level)','asset','debit',NULL,true,NULL),
            ($3,$2,'K052-1510','K052 Suspense detail','asset','debit',3,true,$1)`,
    [nullLevel, company, nullLevelChild]);
  await pool.query(
    `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance,level,is_active,parent_account_id)
     VALUES($1,$2,'K052-1900','K052 Bonds (level 2 leaf)','asset','debit',2,true,NULL)`,
    [raceTarget, company]);
  await pool.query("INSERT INTO companies(id,name) VALUES($1,'K052 other tenant')", [otherCompany]);
  // Another tenant's child under this company's level-1 leaf must not make it a header.
  await pool.query(
    `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance,level,is_active,parent_account_id)
     VALUES($1,$2,'K052-9900','K052 foreign child','asset','debit',3,true,$3)`,
    [foreignChild, otherCompany, flatLeaf]);
  await pool.query(
    `INSERT INTO fiscal_periods(company_id,period_name,period_number,fiscal_year,start_date,end_date,status)
     VALUES($1,'K052 Mar 2026',3,2026,'2026-03-01','2026-03-31','open')`, [company]);

  const { rows } = await pool.query(
    `INSERT INTO gl_journal_entries(company_id,entry_number,entry_date,description,source,status,created_by,posted_at)
     VALUES($1,'K052-JE-1','2026-03-15'::date,'K052 opening','manual','posted',$2,NOW()) RETURNING id`, [company, user]);
  for (const [account, debit, credit] of [[header, 400, 0], [source, 1000, 0], [equity, 0, 1400]] as [string, number, number][]) {
    await pool.query(
      'INSERT INTO gl_journal_lines(journal_entry_id,gl_account_id,debit,credit,company_id) VALUES($1,$2,$3,$4,$5)',
      [rows[0].id, account, debit, credit, company]);
  }
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM gl_journal_lines WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_journal_entries WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_account_balances WHERE gl_account_id IN (SELECT id FROM gl_accounts WHERE company_id=ANY($1))', [[company, otherCompany]]);
    await pool.query('UPDATE gl_accounts SET parent_account_id=NULL WHERE company_id=ANY($1)', [[company, otherCompany]]);
    await pool.query('DELETE FROM gl_accounts WHERE company_id=ANY($1)', [[company, otherCompany]]);
    await pool.query('DELETE FROM fiscal_periods WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=ANY($1)', [[company, otherCompany]]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

it('the balance sheet already ignores a level-2 account that has children', async () => {
  // Supporting fact, not the defect: R400 sits on the header and never appears.
  const bs = await getBalanceSheet(company, AS_AT);
  expect(bs.totalAssets).toBeCloseTo(1000, 2);
});

it('refuses a reclassification whose target is a parent header account', async () => {
  const admitted = await admit(source, header);
  expect(isRefusal(admitted)).toBe(true);
});

it('admits an ordinary level-3 leaf target', async () => {
  const admitted = await admit(header, source);
  expect(isRefusal(admitted)).toBe(false);
});

it("admits a level-1 leaf target, ignoring another tenant's child under it", async () => {
  const admitted = await admit(source, flatLeaf);
  expect(isRefusal(admitted)).toBe(false);
});

it('refuses the header target for the other tenant too, and never leaks its existence', async () => {
  const admitted = await admit(source, header, otherCompany);
  expect(admitted).toEqual({ refused: 'NOT_FOUND' });
});

it('admits a level-3 target that HAS children', async () => {
  // The shape that separates this guard from a blanket "no target with
  // children": both reports select an account at level 3 regardless of its
  // children, so converting one into a header is ordinary chart maintenance.
  const admitted = await admit(source, deepParent);
  expect(isRefusal(admitted)).toBe(false);
});

it('admits a level-2 EXPENSE header — the income statement has no level filter', async () => {
  const admitted = await admit(source, expenseHeader);
  expect(isRefusal(admitted)).toBe(false);
});

it('reads a NULL level as 1 in the refusal, not NaN', async () => {
  const admitted = await admit(source, nullLevel);
  expect(isRefusal(admitted)).toBe(true);
  const { refused } = admitted as { refused: string };
  expect(refused).toContain('level 1 with children');
  expect(refused).not.toContain('NaN');
});

it('holds the header verdict against a concurrent createAccount', async () => {
  // The reclassification locks the journal LINES, and its own write takes only
  // FOR KEY SHARE on the target through gl_accounts_parent_account_id_fkey —
  // which does not conflict with the FOR KEY SHARE a concurrent createAccount
  // needs. So the guard takes FOR UPDATE on a leaf-rule target itself. Two
  // connections: the guard's transaction stays open, and the intruder's INSERT
  // of a child under the target cannot commit inside that window.
  const client = await getPoolForTests().connect();
  try {
    await client.query('BEGIN');
    const admitted = await als.run(
      { client, userId: user, companyId: company, claims: {} } as unknown as Parameters<typeof als.run>[0],
      () => admitReclassification({
        companyId: company, sourceAccountId: source, targetAccountId: raceTarget,
        from: null, to: null, postingDate: '2026-03-31', lockCandidateLines: true,
      }),
    );
    expect(isRefusal(admitted)).toBe(false);

    // Still inside the guard's transaction: createAccount's INSERT blocks.
    const intruder = await pool.connect();
    try {
      await intruder.query('BEGIN');
      await intruder.query("SET LOCAL lock_timeout = '1s'");
      await intruder.query(
        `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance,level,is_active,parent_account_id)
         VALUES($1,$2,'K052-1910','K052 Bonds - detail','asset','debit',3,true,$3)`,
        [raceIntruder, company, raceTarget]);
      throw new Error('the INSERT committed inside the guard window');
    } catch (err) {
      expect(String((err as { code?: string }).code)).toBe('55P03');
    } finally {
      await intruder.query('ROLLBACK');
      intruder.release();
    }
    await client.query('COMMIT');
  } catch (err) {
    // Without this a failing assertion returns the connection to the pool with
    // the transaction still open and `FOR UPDATE` still held, and `afterAll`'s
    // DELETE then blocks until the hook times out — the fixture rows survive
    // into the next run. Same shape as `admit()` above.
    await client.query('ROLLBACK');
    throw err;
  } finally { (client as PoolClient).release(); }

  const { rows } = await pool.query(
    'SELECT COUNT(*)::int AS n FROM gl_accounts WHERE parent_account_id=$1 AND company_id=$2',
    [raceTarget, company]);
  expect(rows[0].n).toBe(0);
});

it('takes NO account lock on the PREVIEW path', async () => {
  // `propose_reclassification` and a dry run reach this guard with
  // lockCandidateLines false. Holding FOR UPDATE on the target for the length
  // of a preview would block every real batch and every merge naming it, to
  // protect a verdict nothing is about to act on. Asserted with no request
  // transaction, because that is what the lock helper refuses to run without.
  const admitted = await admitWithoutTransaction(raceTarget, false);
  expect(isRefusal(admitted)).toBe(false);
});

it('takes NO account lock for an EXPENSE target, even on the write path', async () => {
  // The narrowing that keeps the preview cost bounded and leaves expense-chart
  // work lock-free: the income statement has no level filter, so no expense
  // target can lose anything and there is no verdict to hold.
  const admitted = await admitWithoutTransaction(expenseHeader, true);
  expect(isRefusal(admitted)).toBe(false);
});

it('still refuses a header target on the preview path', async () => {
  // The lock is what the preview drops — not the rule. A dry run that admitted
  // what the live call refuses would be worse than no dry run at all.
  const admitted = await admitWithoutTransaction(header, false);
  expect(isRefusal(admitted)).toBe(true);
});
