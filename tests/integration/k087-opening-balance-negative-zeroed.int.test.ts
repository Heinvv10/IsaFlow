/**
 * K-087 RED. `postOpeningBalances`
 * (git show origin/master:src/modules/accounting/services/core/migrationOpeningBalanceService.ts,
 * lines 62-71) builds each line as
 *   debit:  isDebitNormal && openingBalance > 0 ? openingBalance : 0
 *   credit: !isDebitNormal && openingBalance > 0 ? openingBalance : 0
 * so an account carrying a balance CONTRARY to its normal side (a bank in
 * overdraft, a supplier in debit, a negative accumulated-depreciation contra)
 * posts as 0/0. `parseBalance` (migrationParserService.ts:85-90) keeps the
 * minus sign, so a negative reaches here from any Xero/QuickBooks/Pastel
 * export loaded through POST /api/accounting/migration-execute.
 *
 * Two reachable outcomes, both asserted:
 *   1. a source trial balance that DOES foot is refused with a "does not sum
 *      to zero" error that misstates the operator's own data;
 *   2. when the discarded contras cancel each other, the totals check passes
 *      and the balances vanish silently into a journal of zero-value lines.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { randomUUID } from 'crypto';
import { als } from '@/lib/als';
import { postOpeningBalances } from '@/modules/accounting/services/core/migrationOpeningBalanceService';
import type { ParsedAccount } from '@/modules/accounting/services/core/migrationParserService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const company = randomUUID();
const user = randomUUID();

function run<T>(c: PoolClient, fn: () => Promise<T>): Promise<T> {
  return als.run({ client: c, userId: user, companyId: company, claims: {} } as never, fn);
}

async function account(code: string, name: string, type: string, subtype: string, normal: string) {
  await pool.query(
    `INSERT INTO gl_accounts(company_id,account_code,account_name,account_type,account_subtype,
       normal_balance,is_active) VALUES($1,$2,$3,$4,$5,$6,true)`,
    [company, code, name, type, subtype, normal],
  );
}

const acct = (code: string, name: string, type: string, normal: 'debit' | 'credit', bal: number): ParsedAccount => ({
  sourceCode: code, sourceName: name, sourceType: type, openingBalance: bal,
  mappedType: type as ParsedAccount['mappedType'], mappedNormalBalance: normal,
});

beforeAll(async () => {
  await pool.query("INSERT INTO companies(id,name) VALUES($1,'K087 opening balance fixture')", [company]);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')", [company, user]);
  const y = new Date().getUTCFullYear();
  await pool.query(
    `INSERT INTO fiscal_periods(company_id,period_name,period_number,fiscal_year,start_date,end_date,status)
     VALUES($1,'K087 FY',1,$2,$3,$4,'open')`,
    [company, y, `${y}-01-01`, `${y}-12-31`],
  );
  await account('1000', 'K087 Trade receivables', 'asset', 'receivable', 'debit');
  await account('1010', 'K087 Bank', 'asset', 'bank', 'debit');
  await account('2000', 'K087 Trade payables', 'liability', 'payable', 'credit');
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM gl_journal_lines WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_journal_entries WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_account_balances WHERE gl_account_id IN (SELECT id FROM gl_accounts WHERE company_id=$1)', [company]);
    await pool.query('DELETE FROM gl_accounts WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM fiscal_periods WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM company_users WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=$1', [company]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

/** Post, and report which journal entry the call created so assertions can be
 *  scoped to it rather than to everything the file has posted so far. */
async function post(accounts: ParsedAccount[]) {
  const before = await pool.query('SELECT id FROM gl_journal_entries WHERE company_id=$1', [company]);
  const priorIds = before.rows.map(r => r.id as string);
  const c = await pool.connect();
  await c.query('BEGIN');
  try {
    const lines = await run(c, () => postOpeningBalances(company, user, 'xero', accounts));
    await c.query('COMMIT');
    const after = await pool.query(
      'SELECT id FROM gl_journal_entries WHERE company_id=$1 AND NOT (id = ANY($2::uuid[]))',
      [company, priorIds],
    );
    return { lines, entryIds: after.rows.map(r => r.id as string) };
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
  }
}

/** Signed balance per account code, on each account's own normal side, for one entry. */
async function signedByCode(entryIds: string[]) {
  const { rows } = await pool.query(
    `SELECT a.account_code,
            CASE WHEN a.normal_balance = 'debit'
                 THEN COALESCE(SUM(l.debit),0) - COALESCE(SUM(l.credit),0)
                 ELSE COALESCE(SUM(l.credit),0) - COALESCE(SUM(l.debit),0)
            END::float8 AS signed,
            COALESCE(SUM(l.debit),0)::float8  AS dr,
            COALESCE(SUM(l.credit),0)::float8 AS cr
       FROM gl_journal_lines l JOIN gl_accounts a ON a.id = l.gl_account_id
      WHERE l.company_id=$1 AND l.journal_entry_id = ANY($2::uuid[])
      GROUP BY a.account_code, a.normal_balance ORDER BY a.account_code`,
    [company, entryIds],
  );
  return rows;
}

it('a footing trial balance with a bank in overdraft is imported, not refused', async () => {
  // Debits 1000 - 400 = 600; credits 600. The source foots.
  await post([
    acct('1000', 'K087 Trade receivables', 'asset', 'debit', 1000),
    acct('1010', 'K087 Bank', 'asset', 'debit', -400),
    acct('2000', 'K087 Trade payables', 'liability', 'credit', 600),
  ]);

  const { rows } = await pool.query(
    `SELECT a.account_code, COALESCE(SUM(l.debit),0)::float8 AS dr, COALESCE(SUM(l.credit),0)::float8 AS cr
       FROM gl_journal_lines l JOIN gl_accounts a ON a.id = l.gl_account_id
      WHERE l.company_id=$1 GROUP BY a.account_code ORDER BY a.account_code`, [company]);
  const by = Object.fromEntries(rows.map(r => [r.account_code, r]));
  expect(by['1000']?.dr).toBe(1000);
  // A negative balance on a debit-normal account is a CREDIT of 400, not nothing.
  expect(by['1010']?.cr).toBe(400);
  expect(by['2000']?.cr).toBe(600);
});

it('offsetting contra balances are not silently dropped', async () => {
  // Debit-normal -500 and credit-normal -500. On master the totals check saw
  // 0 = 0 and the entry was refused for zero-value lines; the balances had
  // disappeared. Assert the SIGNED balance of this entry alone — the earlier
  // test posted into the same company, so a total over the whole company
  // would be non-zero whatever this call wrote.
  const { lines, entryIds } = await post([
    acct('1010', 'K087 Bank', 'asset', 'debit', -500),
    acct('2000', 'K087 Trade payables', 'liability', 'credit', -500),
  ]);
  expect(lines).toBe(2);
  expect(entryIds).toHaveLength(1);

  const rows = await signedByCode(entryIds);
  const by = Object.fromEntries(rows.map(r => [r.account_code, r]));
  expect(Object.keys(by).sort()).toEqual(['1010', '2000']);
  // Each balance survives, on the side opposite its account's normal side.
  expect(by['1010'].signed).toBe(-500);
  expect(by['1010'].cr).toBe(500);
  expect(by['1010'].dr).toBe(0);
  expect(by['2000'].signed).toBe(-500);
  expect(by['2000'].dr).toBe(500);
  expect(by['2000'].cr).toBe(0);
  // And the entry is still a balanced journal.
  const totals = rows.reduce((s2, r) => ({ dr: s2.dr + r.dr, cr: s2.cr + r.cr }), { dr: 0, cr: 0 });
  expect(totals.dr).toBe(totals.cr);
});
