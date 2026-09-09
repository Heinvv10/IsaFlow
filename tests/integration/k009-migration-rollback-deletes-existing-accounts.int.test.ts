/**
 * K-009 — migration rollback deletes pre-existing chart accounts.
 *
 * executeMigration's ON CONFLICT DO UPDATE stamped imported_from onto an
 * account the company already had, and rollbackMigration then deleted every
 * row matching that stamp. Two consequences are proven here:
 *  1. an untouched pre-existing account is destroyed by the rollback, and
 *  2. once an account carries posted journal lines the unqualified DELETE
 *     raises a foreign-key violation, so the whole rollback fails.
 *
 * The journal entries carry a real fiscal period, which is what makes
 * trg_gl_jl_balance_update maintain gl_account_balances — the second
 * referencing table that blocks the delete.
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
const period = crypto.randomUUID();

const parsed = (code: string, name: string): ParsedAccount => ({
  sourceCode: code, sourceName: name, sourceType: 'Revenue', openingBalance: 0,
  mappedType: 'revenue', mappedNormalBalance: 'credit', mappedSubtype: 'operating_revenue',
});

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2),($3,$4)', [clean, 'K009 clean fixture', posted, 'K009 posted fixture']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await pool.query(`INSERT INTO fiscal_periods(id,company_id,period_name,period_number,fiscal_year,start_date,end_date)
    VALUES($1,$2,'2026-01',1,2026,'2026-01-01','2026-01-31')`, [period, posted]);
  // Pre-existing chart accounts the company built itself: imported_from IS NULL.
  await pool.query(`INSERT INTO gl_accounts(company_id,account_code,account_name,account_type,normal_balance,level,is_active)
    VALUES($1,'4000','House revenue','revenue','credit',3,true),($2,'4000','House revenue','revenue','credit',3,true)`, [clean, posted]);
  // The posted-company account already carries a posted journal line.
  const je = crypto.randomUUID();
  await pool.query(`INSERT INTO gl_journal_entries(id,company_id,entry_date,created_by,status,description,fiscal_period_id)
    VALUES($1,$2,'2026-01-31',$3,'posted','Pre-existing trading',$4)`, [je, posted, user, period]);
  await pool.query(`INSERT INTO gl_journal_lines(company_id,journal_entry_id,gl_account_id,debit,credit)
    SELECT $1,$2,id,0,250 FROM gl_accounts WHERE company_id=$1 AND account_code='4000'`, [posted, je]);
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM gl_journal_entries WHERE company_id=ANY($1::uuid[])', [companies]);
    await pool.query('DELETE FROM gl_account_balances WHERE gl_account_id IN (SELECT id FROM gl_accounts WHERE company_id=ANY($1::uuid[]))', [companies]);
    await pool.query('DELETE FROM gl_accounts WHERE company_id=ANY($1::uuid[])', [companies]);
    await pool.query('DELETE FROM fiscal_periods WHERE company_id=ANY($1::uuid[])', [companies]);
    await pool.query('DELETE FROM companies WHERE id=ANY($1::uuid[])', [companies]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

it('leaves a pre-existing account untagged, unrenamed and undeleted', async () => {
  const result = await executeMigration(clean, user, 'xero', [parsed('4000', 'Sales'), parsed('4100', 'Other sales')], [], []);
  expect(result.errors).toEqual([
    'Account "4000 Sales": code already used by an account not imported from xero — left unchanged',
  ]);
  expect(result.accountsImported).toBe(1);

  // The pre-existing 4000 keeps a NULL tag AND its own name — a NULL
  // imported_from is what marks an account as the company's own, and nothing
  // records the old name, so an overwrite would be unrecoverable.
  const stamped = await pool.query('SELECT account_code,account_name,imported_from FROM gl_accounts WHERE company_id=$1 ORDER BY account_code', [clean]);
  expect(stamped.rows).toEqual([
    { account_code: '4000', account_name: 'House revenue', imported_from: null },
    { account_code: '4100', account_name: 'Other sales', imported_from: 'xero' },
  ]);

  await expect(rollbackMigration(clean, 'xero')).resolves.toEqual({ deleted: 1, retained: 0, retainedCodes: [] });

  const survivors = await pool.query('SELECT account_code FROM gl_accounts WHERE company_id=$1 ORDER BY account_code', [clean]);
  expect(survivors.rows.map(r => r.account_code)).toEqual(['4000']);
});

it('retains an imported account that carries posted lines instead of aborting', async () => {
  await executeMigration(posted, user, 'xero', [parsed('4000', 'Sales'), parsed('4100', 'Traded'), parsed('4200', 'Untraded')], [], []);

  // Trade on the imported 4100, so the rollback meets a real blocker.
  const je = crypto.randomUUID();
  await pool.query(`INSERT INTO gl_journal_entries(id,company_id,entry_date,created_by,status,description,fiscal_period_id)
    VALUES($1,$2,'2026-01-31',$3,'posted','Post-import trading',$4)`, [je, posted, user, period]);
  await pool.query(`INSERT INTO gl_journal_lines(company_id,journal_entry_id,gl_account_id,debit,credit)
    SELECT $1,$2,id,0,90 FROM gl_accounts WHERE company_id=$1 AND account_code='4100'`, [posted, je]);

  await expect(rollbackMigration(posted, 'xero')).resolves.toEqual({ deleted: 1, retained: 1, retainedCodes: ['4100'] });

  // 4200 goes; 4100 stays and is handed back to the company with no tag, so a
  // later rollback of the same source can never re-arm the delete on it.
  const survivors = await pool.query('SELECT account_code,imported_from FROM gl_accounts WHERE company_id=$1 ORDER BY account_code', [posted]);
  expect(survivors.rows).toEqual([
    { account_code: '4000', imported_from: null },
    { account_code: '4100', imported_from: null },
  ]);
  const lines = await pool.query('SELECT count(*)::int AS n FROM gl_journal_lines WHERE company_id=$1', [posted]);
  expect(lines.rows[0].n).toBe(2);
});
