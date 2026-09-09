/**
 * K-087 adjacent cases, real PostgreSQL.
 *
 * 1. A source that genuinely does NOT foot is still refused, and the message now
 *    quotes the operator's own figures (the contra counted on its true side).
 * 2. The posted opening journal is balanced and every account carries the
 *    signed balance the source stated.
 * 3. The mirror direction: a credit-normal account carrying a debit balance
 *    lands on the debit side, and a zero balance still produces no line at all.
 * 4. A second company's opening balances are untouched by the import.
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
const companyA = randomUUID();
const companyB = randomUUID();
const user = randomUUID();
const year = new Date().getUTCFullYear();

function run<T>(c: PoolClient, companyId: string, fn: () => Promise<T>): Promise<T> {
  return als.run({ client: c, userId: user, companyId, claims: {} } as never, fn);
}

async function company(id: string, name: string) {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [id, name]);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')", [id, user]);
  await pool.query(
    `INSERT INTO fiscal_periods(company_id,period_name,period_number,fiscal_year,start_date,end_date,status)
     VALUES($1,'K087 FY',1,$2,$3,$4,'open')`,
    [id, year, `${year}-01-01`, `${year}-12-31`],
  );
}

async function account(companyId: string, code: string, name: string, type: string, subtype: string, normal: string) {
  await pool.query(
    `INSERT INTO gl_accounts(company_id,account_code,account_name,account_type,account_subtype,
       normal_balance,is_active) VALUES($1,$2,$3,$4,$5,$6,true)`,
    [companyId, code, name, type, subtype, normal],
  );
}

const acct = (code: string, name: string, type: string, normal: 'debit' | 'credit', bal: number): ParsedAccount => ({
  sourceCode: code, sourceName: name, sourceType: type, openingBalance: bal,
  mappedType: type as ParsedAccount['mappedType'], mappedNormalBalance: normal,
});


beforeAll(async () => {
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await company(companyA, 'K087 adjacent A');
  await company(companyB, 'K087 adjacent B');
  for (const id of [companyA, companyB]) {
    await account(id, '1000', 'K087 Trade receivables', 'asset', 'receivable', 'debit');
    await account(id, '1010', 'K087 Bank', 'asset', 'bank', 'debit');
    await account(id, '2000', 'K087 Trade payables', 'liability', 'payable', 'credit');
  }
});

afterAll(async () => {
  try {
    for (const id of [companyA, companyB]) {
      await pool.query('DELETE FROM gl_journal_lines WHERE company_id=$1', [id]);
      await pool.query('DELETE FROM gl_journal_entries WHERE company_id=$1', [id]);
      await pool.query('DELETE FROM gl_account_balances WHERE gl_account_id IN (SELECT id FROM gl_accounts WHERE company_id=$1)', [id]);
      await pool.query('DELETE FROM gl_accounts WHERE company_id=$1', [id]);
      await pool.query('DELETE FROM migration_sessions WHERE company_id=$1', [id]);
      await pool.query('DELETE FROM fiscal_periods WHERE company_id=$1', [id]);
      await pool.query('DELETE FROM company_users WHERE company_id=$1', [id]);
      await pool.query('DELETE FROM companies WHERE id=$1', [id]);
    }
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

async function inTx<T>(companyId: string, fn: () => Promise<T>): Promise<T> {
  const c = await pool.connect();
  await c.query('BEGIN');
  try {
    const out = await run(c, companyId, fn);
    await c.query('COMMIT');
    return out;
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
  }
}

it('a source that does not foot is refused, quoting the operator\'s own figures', async () => {
  // Debits 1000 - 400 = 600; credits 700. Genuinely R100 out.
  await expect(inTx(companyA, () => postOpeningBalances(companyA, user, 'xero', [
    acct('1000', 'K087 Trade receivables', 'asset', 'debit', 1000),
    acct('1010', 'K087 Bank', 'asset', 'debit', -400),
    acct('2000', 'K087 Trade payables', 'liability', 'credit', 700),
  ]))).rejects.toThrow('debits R1000.00 vs credits R1100.00 (difference R100.00)');

  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM gl_journal_entries WHERE company_id=$1', [companyA]);
  expect(rows[0].n).toBe(0);
});

it('the posted opening journal balances and each account carries its signed balance', async () => {
  const lines = await inTx(companyA, () => postOpeningBalances(companyA, user, 'xero', [
    acct('1000', 'K087 Trade receivables', 'asset', 'debit', 1000),
    acct('1010', 'K087 Bank', 'asset', 'debit', -400),
    acct('2000', 'K087 Trade payables', 'liability', 'credit', 600),
  ]));
  expect(lines).toBe(3);

  const { rows } = await pool.query(
    `SELECT a.account_code, a.normal_balance,
            COALESCE(SUM(l.debit),0)::float8  AS dr,
            COALESCE(SUM(l.credit),0)::float8 AS cr
       FROM gl_journal_lines l JOIN gl_accounts a ON a.id = l.gl_account_id
      WHERE l.company_id=$1 GROUP BY a.account_code, a.normal_balance`, [companyA]);
  const totals = rows.reduce((s, r) => ({ dr: s.dr + r.dr, cr: s.cr + r.cr }), { dr: 0, cr: 0 });
  expect(totals.dr).toBe(totals.cr);

  // Signed balance on the account's own normal side must equal the source figure.
  const signed = Object.fromEntries(rows.map(r => [
    r.account_code, r.normal_balance === 'debit' ? r.dr - r.cr : r.cr - r.dr,
  ]));
  expect(signed['1000']).toBe(1000);
  expect(signed['1010']).toBe(-400);
  expect(signed['2000']).toBe(600);
});

it('the second company is untouched by company A\'s import', async () => {
  const { rows } = await pool.query(
    'SELECT COUNT(*)::int AS n FROM gl_journal_lines WHERE company_id=$1', [companyB]);
  expect(rows[0].n).toBe(0);
});

it('a credit-normal account in debit lands on the debit side, and a zero balance makes no line', async () => {
  const lines = await inTx(companyB, () => postOpeningBalances(companyB, user, 'xero', [
    acct('2000', 'K087 Trade payables', 'liability', 'credit', -300),
    acct('1000', 'K087 Trade receivables', 'asset', 'debit', -300),
    acct('1010', 'K087 Bank', 'asset', 'debit', 0),
  ]));
  expect(lines).toBe(2);

  const { rows } = await pool.query(
    `SELECT a.account_code, a.normal_balance,
            COALESCE(SUM(l.debit),0)::float8  AS dr,
            COALESCE(SUM(l.credit),0)::float8 AS cr
       FROM gl_journal_lines l JOIN gl_accounts a ON a.id = l.gl_account_id
      WHERE l.company_id=$1 GROUP BY a.account_code, a.normal_balance`, [companyB]);
  expect(rows.map(r => r.account_code).sort()).toEqual(['1000', '2000']);

  const by = Object.fromEntries(rows.map(r => [r.account_code, r]));
  expect(by['2000'].dr).toBe(300);   // credit-normal payable, debit balance
  expect(by['2000'].cr).toBe(0);
  expect(by['1000'].cr).toBe(300);   // debit-normal receivable, credit balance
  expect(by['1000'].dr).toBe(0);
});
