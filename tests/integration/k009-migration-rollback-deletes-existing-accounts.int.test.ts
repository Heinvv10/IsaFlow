/**
 * K-009 — migration rollback deletes pre-existing chart accounts.
 *
 * executeMigration's ON CONFLICT DO UPDATE stamps imported_from onto an
 * account the company already had, and rollbackMigration then deletes every
 * row matching that stamp. Two consequences are proven here:
 *  1. an untouched pre-existing account is destroyed by the rollback, and
 *  2. once that account carries posted journal lines the unqualified DELETE
 *     raises a foreign-key violation, so the whole rollback fails.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { executeMigration, rollbackMigration } from '../../src/modules/accounting/services/core/migrationExecuteService';
import type { ParsedAccount } from '../../src/modules/accounting/services/core/migrationParserService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const clean = crypto.randomUUID(), posted = crypto.randomUUID(), user = crypto.randomUUID();
const companies = [clean, posted];

const parsed = (code: string, name: string): ParsedAccount => ({
  sourceCode: code, sourceName: name, sourceType: 'Revenue', openingBalance: 0,
  mappedType: 'revenue', mappedNormalBalance: 'credit', mappedSubtype: 'operating_revenue',
});

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2),($3,$4)', [clean, 'K009 clean fixture', posted, 'K009 posted fixture']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  // Pre-existing chart accounts the company built itself: imported_from IS NULL.
  await pool.query(`INSERT INTO gl_accounts(company_id,account_code,account_name,account_type,normal_balance,level,is_active)
    VALUES($1,'4000','House revenue','revenue','credit',3,true),($2,'4000','House revenue','revenue','credit',3,true)`, [clean, posted]);
  // The posted-company account already carries a posted journal line.
  const je = crypto.randomUUID();
  await pool.query(`INSERT INTO gl_journal_entries(id,company_id,entry_date,created_by,status,description)
    VALUES($1,$2,'2026-01-31',$3,'posted','Pre-existing trading')`, [je, posted, user]);
  await pool.query(`INSERT INTO gl_journal_lines(company_id,journal_entry_id,gl_account_id,debit,credit)
    SELECT $1,$2,id,0,250 FROM gl_accounts WHERE company_id=$1 AND account_code='4000'`, [posted, je]);
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM gl_journal_entries WHERE company_id=ANY($1::uuid[])', [companies]);
    await pool.query('DELETE FROM gl_accounts WHERE company_id=ANY($1::uuid[])', [companies]);
    await pool.query('DELETE FROM companies WHERE id=ANY($1::uuid[])', [companies]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

it('keeps a pre-existing account the import merely re-stamped', async () => {
  const result = await executeMigration(clean, user, 'xero', [parsed('4000', 'Sales'), parsed('4100', 'Other sales')], [], []);
  expect(result.errors).toEqual([]);
  const stamped = await pool.query('SELECT account_code,imported_from FROM gl_accounts WHERE company_id=$1 ORDER BY account_code', [clean]);
  // The pre-existing 4000 keeps a NULL tag — a NULL imported_from is exactly
  // what marks an account as the company's own and shields it from rollback.
  expect(stamped.rows).toEqual([
    { account_code: '4000', imported_from: null },
    { account_code: '4100', imported_from: 'xero' },
  ]);

  await rollbackMigration(clean, 'xero');

  const survivors = await pool.query('SELECT account_code FROM gl_accounts WHERE company_id=$1 ORDER BY account_code', [clean]);
  expect(survivors.rows.map(r => r.account_code)).toEqual(['4000']);
});

it('rolls back without destroying or failing on an account carrying posted lines', async () => {
  await executeMigration(posted, user, 'xero', [parsed('4000', 'Sales'), parsed('4100', 'Other sales')], [], []);

  await expect(rollbackMigration(posted, 'xero')).resolves.toEqual({ deleted: 1 });

  const survivors = await pool.query('SELECT account_code FROM gl_accounts WHERE company_id=$1 ORDER BY account_code', [posted]);
  expect(survivors.rows.map(r => r.account_code)).toEqual(['4000']);
  const lines = await pool.query('SELECT count(*)::int AS n FROM gl_journal_lines WHERE company_id=$1', [posted]);
  expect(lines.rows[0].n).toBe(1);
});
