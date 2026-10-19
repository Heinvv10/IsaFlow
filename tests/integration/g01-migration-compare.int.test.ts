/**
 * G-01 final: the two migration balance comparisons (verifyBalances after an import, and the Sage comparison
 * report) summed lines over `LEFT JOIN gl_journal_entries ... AND je.status = 'posted'` with no gate on the
 * joined entry, so a DRAFT line was counted and the comparison showed a difference against a source that
 * matched the posted ledger. Both are ledger-to-ledger reconciliations of ALL time, and the source's balances
 * already carry the year's P&L rolled into retained income, so they INCLUDE the stored year-end close.
 *
 * (generateComparison also selected `sa.sage_account_id` and `sa.name`, columns sage_accounts does not have,
 * so it threw 42703 on every call; it now selects the real ones.)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { newTenant, seedTenant, cleanupTenant } from './helpers/g01Fixture';
import { closeFiscalYear } from '../../src/modules/accounting/services/gl/yearEndCloseService';
import { verifyBalances } from '../../src/modules/accounting/services/core/migrationExecuteService';
import { generateComparison } from '../../src/modules/accounting/services/core/sageMigrationCompareService';

assertDisposable();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const user = crypto.randomUUID();
const t = newTenant();

/** Normal-side balance of an account over POSTED entries, the stored close included: what the source system holds. */
async function posted(accountId: string, credit: boolean): Promise<number> {
  const r = await pool.query(
    `SELECT SUM(jl.${credit ? 'credit - jl.debit' : 'debit - jl.credit'})::numeric AS n FROM gl_journal_lines jl
     JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
     WHERE je.company_id=$1 AND jl.gl_account_id=$2 AND je.status='posted'`, [t.company, accountId]);
  return Number(r.rows[0].n);
}

beforeAll(async () => {
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `g01mc-${user}@test.local`]);
  await seedTenant(pool, t, user, 'G01 migration compare');
  // A DRAFT line on the bank and on revenue, then the year-end close of FY2025.
  const draft = crypto.randomUUID();
  await pool.query(
    `INSERT INTO gl_journal_entries(id,company_id,entry_number,entry_date,fiscal_period_id,description,source,status,created_by)
     VALUES($1,$2,'DRAFT-1','2025-08-01',$3,'draft','manual','draft',$4)`, [draft, t.company, t.period.p25, user]);
  await pool.query(
    `INSERT INTO gl_journal_lines(journal_entry_id,gl_account_id,debit,credit,description,company_id)
     VALUES($1,$2,15,0,'d',$4),($1,$3,0,15,'d',$4)`, [draft, t.acct.bank, t.acct.revenue, t.company]);
  await closeFiscalYear(t.company, '2025', user);
  for (const [accountId, code] of [[t.acct.bank, '1000'], [t.acct.revenue, '4000']] as const) {
    await pool.query(
      `INSERT INTO sage_accounts(id,company_id,sage_id,account_code,account_name,balance,gl_account_id,mapping_status)
       VALUES(gen_random_uuid(),$1,$2,$3,'sage',$4,$5,'mapped')`,
      [t.company, `S-${code}`, code, await posted(accountId, code === '4000'), accountId]);
  }
}, 120000);

afterAll(async () => {
  try {
    await pool.query('DELETE FROM gl_migration_comparisons WHERE company_id=$1', [t.company]);
    await pool.query('DELETE FROM sage_accounts WHERE company_id=$1', [t.company]);
    await cleanupTenant(pool, t);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

describe('a source that matches the posted ledger compares as matching', () => {
  it('verifyBalances: no difference on the bank (a draft line) or on revenue (a draft line; the stored close is counted)', async () => {
    const results = await verifyBalances(t.company, [
      { sourceCode: '1000', sourceName: 'Bank', sourceType: 'asset', openingBalance: await posted(t.acct.bank, false) },
      { sourceCode: '4000', sourceName: 'Sales', sourceType: 'revenue', openingBalance: await posted(t.acct.revenue, true) },
    ]);
    expect(results.map((r) => [r.accountCode, r.difference, r.matched])).toEqual([['1000', 0, true], ['4000', 0, true]]);
  });

  it('generateComparison: the Sage report shows no differences and is balanced', async () => {
    const report = await generateComparison(t.company, user);
    expect(report.differences).toEqual([]);
    expect(report.isBalanced).toBe(true);
  });
});
