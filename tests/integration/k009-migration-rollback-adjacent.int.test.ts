/**
 * K-009 adjacent cases for the rollback guard.
 *  1. An account the import itself created, which later carries posted journal
 *     lines, is retained rather than aborting the rollback with 23503.
 *  2. Rollback is tenant-scoped: an identically coded imported account in
 *     another company is untouched.
 *  3. Re-importing from a second source does not re-tag an account, so a
 *     rollback of that second source deletes nothing.
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

const parsed = (code: string, name: string): ParsedAccount => ({
  sourceCode: code, sourceName: name, sourceType: 'Revenue', openingBalance: 0,
  mappedType: 'revenue', mappedNormalBalance: 'credit', mappedSubtype: 'operating_revenue',
});

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2),($3,$4)', [owner, 'K009 owner fixture', neighbour, 'K009 neighbour fixture']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM gl_journal_entries WHERE company_id=ANY($1::uuid[])', [companies]);
    await pool.query('DELETE FROM gl_accounts WHERE company_id=ANY($1::uuid[])', [companies]);
    await pool.query('DELETE FROM companies WHERE id=ANY($1::uuid[])', [companies]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

it('retains an imported account that has been posted to, and leaves the neighbour tenant alone', async () => {
  await executeMigration(owner, user, 'xero', [parsed('5000', 'Traded'), parsed('5100', 'Untraded')], [], []);
  await executeMigration(neighbour, user, 'xero', [parsed('5000', 'Traded'), parsed('5100', 'Untraded')], [], []);

  // Trade on the owner's imported 5000 only.
  const je = crypto.randomUUID();
  await pool.query(`INSERT INTO gl_journal_entries(id,company_id,entry_date,created_by,status,description)
    VALUES($1,$2,'2026-02-28',$3,'posted','Post-import trading')`, [je, owner, user]);
  await pool.query(`INSERT INTO gl_journal_lines(company_id,journal_entry_id,gl_account_id,debit,credit)
    SELECT $1,$2,id,0,400 FROM gl_accounts WHERE company_id=$1 AND account_code='5000'`, [owner, je]);

  await expect(rollbackMigration(owner, 'xero')).resolves.toEqual({ deleted: 1 });

  const kept = await pool.query('SELECT account_code FROM gl_accounts WHERE company_id=$1 ORDER BY account_code', [owner]);
  expect(kept.rows.map(r => r.account_code)).toEqual(['5000']);
  const lines = await pool.query('SELECT count(*)::int AS n FROM gl_journal_lines WHERE company_id=$1', [owner]);
  expect(lines.rows[0].n).toBe(1);

  const neighbourAccounts = await pool.query('SELECT account_code FROM gl_accounts WHERE company_id=$1 ORDER BY account_code', [neighbour]);
  expect(neighbourAccounts.rows.map(r => r.account_code)).toEqual(['5000', '5100']);
});

it('does not re-tag an account when a second source imports the same code', async () => {
  await executeMigration(neighbour, user, 'quickbooks', [parsed('5100', 'Untraded, again')], [], []);

  const tags = await pool.query('SELECT account_code,imported_from FROM gl_accounts WHERE company_id=$1 ORDER BY account_code', [neighbour]);
  expect(tags.rows).toEqual([
    { account_code: '5000', imported_from: 'xero' },
    { account_code: '5100', imported_from: 'xero' },
  ]);

  await expect(rollbackMigration(neighbour, 'quickbooks')).resolves.toEqual({ deleted: 0 });
  const survivors = await pool.query('SELECT count(*)::int AS n FROM gl_accounts WHERE company_id=$1', [neighbour]);
  expect(survivors.rows[0].n).toBe(2);
});
