/**
 * K-009 adjacent cases for the rollback guard.
 *  1. A blocker that is NOT a journal line — the trigger-maintained
 *     gl_account_balances row, which outlives the lines that created it —
 *     retains its own account and nothing else.
 *  2. A bank account pointing at an imported GL account does the same.
 *  3. Rollback is tenant-scoped: an identically coded imported account in
 *     another company is untouched.
 *  4. Re-importing the same code from a second source neither re-tags the
 *     account nor silently overwrites it; it is reported and left alone.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { executeMigration, rollbackMigration } from '../../src/modules/accounting/services/core/migrationExecuteService';
import type { ParsedAccount } from '../../src/modules/accounting/services/core/migrationParserService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const owner = crypto.randomUUID(), neighbour = crypto.randomUUID(), user = crypto.randomUUID();
const companies = [owner, neighbour];
const period = crypto.randomUUID();

const parsed = (code: string, name: string): ParsedAccount => ({
  sourceCode: code, sourceName: name, sourceType: 'Revenue', openingBalance: 0,
  mappedType: 'revenue', mappedNormalBalance: 'credit', mappedSubtype: 'operating_revenue',
});

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2),($3,$4)', [owner, 'K009 owner fixture', neighbour, 'K009 neighbour fixture']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await pool.query(`INSERT INTO fiscal_periods(id,company_id,period_name,period_number,fiscal_year,start_date,end_date)
    VALUES($1,$2,'2026-02',2,2026,'2026-02-01','2026-02-28')`, [period, owner]);
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM bank_accounts WHERE company_id=ANY($1::uuid[])', [companies]);
    await pool.query('DELETE FROM gl_journal_entries WHERE company_id=ANY($1::uuid[])', [companies]);
    await pool.query('DELETE FROM gl_account_balances WHERE gl_account_id IN (SELECT id FROM gl_accounts WHERE company_id=ANY($1::uuid[]))', [companies]);
    await pool.query('DELETE FROM gl_accounts WHERE company_id=ANY($1::uuid[])', [companies]);
    await pool.query('DELETE FROM fiscal_periods WHERE company_id=ANY($1::uuid[])', [companies]);
    await pool.query('DELETE FROM companies WHERE id=ANY($1::uuid[])', [companies]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

it('retains accounts blocked by a balance row or a bank account, and leaves the neighbour tenant alone', async () => {
  await executeMigration(owner, user, 'xero', [parsed('5000', 'Balanced'), parsed('5100', 'Banked'), parsed('5200', 'Untouched')], [], []);
  await executeMigration(neighbour, user, 'xero', [parsed('5000', 'Balanced'), parsed('5100', 'Banked'), parsed('5200', 'Untouched')], [], []);

  // 5000: post a line, then delete it. trg_gl_jl_balance_update zeroes the
  // gl_account_balances row rather than removing it, so the account has no
  // journal lines and is still referenced — a journal-line-only guard misses it.
  const je = crypto.randomUUID();
  await pool.query(`INSERT INTO gl_journal_entries(id,company_id,entry_date,created_by,status,description,fiscal_period_id)
    VALUES($1,$2,'2026-02-28',$3,'posted','Reversed trading',$4)`, [je, owner, user, period]);
  await pool.query(`INSERT INTO gl_journal_lines(company_id,journal_entry_id,gl_account_id,debit,credit)
    SELECT $1,$2,id,0,400 FROM gl_accounts WHERE company_id=$1 AND account_code='5000'`, [owner, je]);
  await pool.query('DELETE FROM gl_journal_lines WHERE company_id=$1', [owner]);
  const balances = await pool.query(
    'SELECT count(*)::int AS n FROM gl_account_balances b JOIN gl_accounts a ON a.id=b.gl_account_id WHERE a.company_id=$1', [owner]);
  expect(balances.rows[0].n).toBe(1);

  // 5100: a bank account, which is one of the dozens of NO ACTION FKs on
  // gl_accounts that have nothing to do with the ledger.
  await pool.query(`INSERT INTO bank_accounts(company_id,account_name,gl_account_id)
    SELECT $1,'Cheque',id FROM gl_accounts WHERE company_id=$1 AND account_code='5100'`, [owner]);

  await expect(rollbackMigration(owner, 'xero')).resolves.toEqual({ deleted: 1, retained: 2, retainedCodes: ['5000', '5100'] });

  const kept = await pool.query('SELECT account_code,imported_from FROM gl_accounts WHERE company_id=$1 ORDER BY account_code', [owner]);
  expect(kept.rows).toEqual([
    { account_code: '5000', imported_from: null },
    { account_code: '5100', imported_from: null },
  ]);

  const neighbourAccounts = await pool.query('SELECT account_code FROM gl_accounts WHERE company_id=$1 ORDER BY account_code', [neighbour]);
  expect(neighbourAccounts.rows.map(r => r.account_code)).toEqual(['5000', '5100', '5200']);
});

it('does not re-tag or overwrite an account when a second source imports the same code', async () => {
  const result = await executeMigration(neighbour, user, 'quickbooks', [parsed('5100', 'Renamed by QuickBooks')], [], []);
  expect(result.errors).toEqual([
    'Account "5100 Renamed by QuickBooks": code already used by an account not imported from quickbooks — left unchanged',
  ]);
  expect(result.accountsImported).toBe(0);

  const tags = await pool.query('SELECT account_code,account_name,imported_from FROM gl_accounts WHERE company_id=$1 ORDER BY account_code', [neighbour]);
  expect(tags.rows).toEqual([
    { account_code: '5000', account_name: 'Balanced', imported_from: 'xero' },
    { account_code: '5100', account_name: 'Banked', imported_from: 'xero' },
    { account_code: '5200', account_name: 'Untouched', imported_from: 'xero' },
  ]);

  await expect(rollbackMigration(neighbour, 'quickbooks')).resolves.toEqual({ deleted: 0, retained: 0, retainedCodes: [] });
  const survivors = await pool.query('SELECT count(*)::int AS n FROM gl_accounts WHERE company_id=$1', [neighbour]);
  expect(survivors.rows[0].n).toBe(3);
});
