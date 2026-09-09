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
 *  5. An account the conflict guard refused is not resolvable for opening
 *     balances either, so the source's trial balance is refused whole rather
 *     than posted onto the company's own account.
 *  6. Under a request transaction the savepoint keeps the transaction usable
 *     after the foreign-key refusal, which is what the loop depends on.
 *  7. Re-importing the same source after a partial rollback says WHY it will
 *     not post, naming the released account rather than an import that failed.
 *  8. Both classes of opening-balance refusal are reported in one message.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { als } from '@/lib/als';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { executeMigration, rollbackMigration } from '../../src/modules/accounting/services/core/migrationExecuteService';
import type { ParsedAccount } from '../../src/modules/accounting/services/core/migrationParserService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const owner = crypto.randomUUID(), neighbour = crypto.randomUUID(), user = crypto.randomUUID();
const blocked = crypto.randomUUID(), txCo = crypto.randomUUID(), reimport = crypto.randomUUID();
const companies = [owner, neighbour, blocked, txCo, reimport];
const period = crypto.randomUUID();

const parsed = (code: string, name: string): ParsedAccount => ({
  sourceCode: code, sourceName: name, sourceType: 'Revenue', openingBalance: 0,
  mappedType: 'revenue', mappedNormalBalance: 'credit', mappedSubtype: 'operating_revenue',
});

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2),($3,$4),($5,$6),($7,$8),($9,$10)',
    [owner, 'K009 owner fixture', neighbour, 'K009 neighbour fixture', blocked, 'K009 blocked fixture',
     txCo, 'K009 tx fixture', reimport, 'K009 reimport fixture']);
  await pool.query(`INSERT INTO gl_accounts(company_id,account_code,account_name,account_type,normal_balance,level,is_active)
    VALUES($1,'7000','House cash','asset','debit',3,true)`, [blocked]);
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
    'Account "5100 Renamed by QuickBooks": code already used by an account the quickbooks import does not own — it was created here, or a partial rollback released it — left unchanged (renumber the source row, or delete the existing account, then re-run)',
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

it('refuses the whole opening trial balance when the guard skipped one of its accounts', async () => {
  const result = await executeMigration(blocked, user, 'xero', [
    { sourceCode: '7000', sourceName: 'Cash at bank', sourceType: 'Asset', openingBalance: 100,
      mappedType: 'asset', mappedNormalBalance: 'debit', mappedSubtype: 'current_asset' },
    { sourceCode: '7100', sourceName: 'Sales', sourceType: 'Revenue', openingBalance: 100,
      mappedType: 'revenue', mappedNormalBalance: 'credit', mappedSubtype: 'operating_revenue' },
  ], [], []);

  expect(result.errors).toEqual([
    'Account "7000 Cash at bank": code already used by an account the xero import does not own — it was created here, or a partial rollback released it — left unchanged (renumber the source row, or delete the existing account, then re-run)',
    expect.stringContaining('7000 Cash at bank already exists as an account the xero import does not own'),
  ]);
  expect(result.openingBalancesSet).toBe(0);

  // "Left unchanged" has to mean unchanged: no opening balance may land on the
  // company's own account, and the rest of the journal must not post either —
  // half a trial balance is an out-of-balance chart.
  const house = await pool.query('SELECT account_name,account_type,imported_from FROM gl_accounts WHERE company_id=$1 AND account_code=$2', [blocked, '7000']);
  expect(house.rows).toEqual([{ account_name: 'House cash', account_type: 'asset', imported_from: null }]);
  const lines = await pool.query('SELECT count(*)::int AS n FROM gl_journal_lines WHERE company_id=$1', [blocked]);
  expect(lines.rows[0].n).toBe(0);
  const entries = await pool.query('SELECT count(*)::int AS n FROM gl_journal_entries WHERE company_id=$1', [blocked]);
  expect(entries.rows[0].n).toBe(0);
});

it('keeps the request transaction usable after the foreign-key refusal', async () => {
  await executeMigration(txCo, user, 'xero', [parsed('8000', 'Banked'), parsed('8100', 'Untouched')], [], []);
  await pool.query(`INSERT INTO bank_accounts(company_id,account_name,gl_account_id)
    SELECT $1,'Cheque',id FROM gl_accounts WHERE company_id=$1 AND account_code='8000'`, [txCo]);

  // Called directly, withSavepoint degrades to a plain call and each query gets
  // its own connection. Inside a request there is ONE transaction, and a 23503
  // aborts it unless the savepoint rolls back — the property the loop rests on.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await als.run(
      { client, userId: user, companyId: txCo, claims: { sub: user } },
      () => rollbackMigration(txCo, 'xero'),
    );
    expect(result).toEqual({ deleted: 1, retained: 1, retainedCodes: ['8000'] });
    // The transaction survived the refusal: a poisoned one raises 25P02 here.
    await expect(client.query('SELECT 1 AS ok')).resolves.toMatchObject({ rows: [{ ok: 1 }] });
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => { /* the original error is the one worth raising */ });
    throw err;
  } finally {
    client.release();
  }

  const survivors = await pool.query('SELECT account_code,imported_from FROM gl_accounts WHERE company_id=$1 ORDER BY account_code', [txCo]);
  expect(survivors.rows).toEqual([{ account_code: '8000', imported_from: null }]);
});

it('names the released account when the same source is re-imported after a partial rollback', async () => {
  // Self-contained: this test performs its own partial rollback rather than
  // reading what an earlier test left behind, so reordering or running it with
  // .only cannot turn it into a confusing failure.
  await executeMigration(reimport, user, 'xero', [parsed('9000', 'Banked'), parsed('9100', 'Untouched')], [], []);
  await pool.query(`INSERT INTO bank_accounts(company_id,account_name,gl_account_id)
    SELECT $1,'Cheque',id FROM gl_accounts WHERE company_id=$1 AND account_code='9000'`, [reimport]);
  await expect(rollbackMigration(reimport, 'xero')).resolves.toEqual({ deleted: 1, retained: 1, retainedCodes: ['9000'] });

  // The recovery workflow: fix the source file, re-import. It must say what is
  // actually in the way — the operator still holds 9000, now untagged.
  const result = await executeMigration(reimport, user, 'xero', [
    { sourceCode: '9000', sourceName: 'Banked', sourceType: 'Asset', openingBalance: 100,
      mappedType: 'asset', mappedNormalBalance: 'debit', mappedSubtype: 'current_asset' },
    { sourceCode: '9100', sourceName: 'Sales', sourceType: 'Revenue', openingBalance: 100,
      mappedType: 'revenue', mappedNormalBalance: 'credit', mappedSubtype: 'operating_revenue' },
  ], [], []);

  expect(result.errors).toEqual([
    expect.stringContaining('code already used by an account the xero import does not own — it was created here, or a partial rollback released it'),
    'Opening balances: opening balances not imported: 9000 Banked already exists as an account the xero import does not own (renumber the source row, or delete the existing account, then re-run)',
  ]);
  expect(result.accountsImported).toBe(1);
  expect(result.openingBalancesSet).toBe(0);

  // 9100 is re-created and tagged; 9000 is still the company's own, untouched.
  const after = await pool.query('SELECT account_code,account_name,imported_from FROM gl_accounts WHERE company_id=$1 ORDER BY account_code', [reimport]);
  expect(after.rows).toEqual([
    { account_code: '9000', account_name: 'Banked', imported_from: null },
    { account_code: '9100', account_name: 'Sales', imported_from: 'xero' },
  ]);
  const lines = await pool.query('SELECT count(*)::int AS n FROM gl_journal_lines WHERE company_id=$1', [reimport]);
  expect(lines.rows[0].n).toBe(0);
});
