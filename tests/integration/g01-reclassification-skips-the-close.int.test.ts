/**
 * G-01 adversarial review: a reclassification after the year-end close must not move the close.
 *
 * `reclassification/candidates.ts` lists every posted line on the source account, so with a
 * posting_date the closing line (YE-2025, Dr 4000) was movable. The preview (impact.ts skips
 * the close) said 1750 moved to 4100, but the posted batch also contra'd the closing line, and
 * that contra (source 'reclassification') is not excluded from reports, so every report kept
 * 4100 = 0 and 4000 = 600 and four journals were left in the ledger. The close is now a SKIP
 * ('year_end_close', in the universe, with a reason), and dimension tagging refuses it too.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import { als } from '../../src/lib/als';
import { getPoolForTests } from '../../src/lib/neon';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { closeFiscalYear } from '../../src/modules/accounting/services/gl/yearEndCloseService';
import { clearSystemAccountCache } from '../../src/modules/accounting/services/gl/systemAccountResolver';
import { getTrialBalanceReport } from '../../src/modules/accounting/services/gl/trialBalanceService';
import { planDimensionTags } from '../../src/modules/accounting/services/gl/dimensions/dimensionTagPlan';
import { proposeReclassificationTool } from '../../src/lib/mcp/tools/reclassificationPropose';
import { postReclassificationBatchTool } from '../../src/lib/mcp/tools/writeReclassification';
import type { McpToolContext } from '../../src/lib/mcp/types';

assertDisposable();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const user = crypto.randomUUID();
const company = crypto.randomUUID();
const [bank, retained, revenue, rev2, p25, p26] = Array.from({ length: 6 }, () => crypto.randomUUID());
const ctx = {
  companyId: company, userId: user, scopes: ['read:reports', 'write:journals', 'write:post'],
  tokenJti: 'jti-g01', oauthAppId: null,
} as unknown as McpToolContext;
const args = {
  source_account_id: revenue, target_account_id: rev2,
  from: '2025-01-01', to: '2025-12-31', posting_date: '2026-06-30',
};

async function post(n: string, date: string, p: string, credit: string, amount: number) {
  const entry = crypto.randomUUID();
  await pool.query(
    `INSERT INTO gl_journal_entries(id,company_id,entry_number,entry_date,fiscal_period_id,description,source,status,created_by,posted_by,posted_at)
     VALUES($1,$2,$3,$4,$5,'seed','manual','posted',$6,$6,now())`, [entry, company, n, date, p, user]);
  await pool.query(
    `INSERT INTO gl_journal_lines(journal_entry_id,gl_account_id,debit,credit,description,company_id)
     VALUES($1,$2,$4,0,'seed',$5),($1,$3,0,$4,'seed',$5)`, [entry, bank, credit, amount, company]);
}

beforeAll(async () => {
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `g01rc-${user}@test.local`]);
  await pool.query('INSERT INTO companies(id,name,financial_year_start) VALUES($1,$2,1)', [company, 'G01 reclass after close']);
  await pool.query(
    `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_active,is_system_account)
     VALUES($1,$5,'1000','Bank','asset','bank','debit',true,false),
            ($2,$5,'3200','Retained Earnings','equity','retained_earnings','credit',true,true),
            ($3,$5,'4000','Sales','revenue',NULL,'credit',true,false),
            ($4,$5,'4100','Sales (other)','revenue',NULL,'credit',true,false)`,
    [bank, retained, revenue, rev2, company]);
  await pool.query(
    `INSERT INTO fiscal_periods(id,company_id,period_name,period_number,fiscal_year,start_date,end_date,status)
     VALUES($1,$3,'FY2025',1,2025,'2025-01-01','2025-12-31','closed'),($2,$3,'FY2026',1,2026,'2026-01-01','2026-12-31','open')`,
    [p25, p26, company]);
  clearSystemAccountCache(company);
  await post('S25', '2025-06-01', p25, revenue, 1750);
  await post('S26', '2026-02-01', p26, revenue, 600);
});

afterAll(async () => {
  try {
    clearSystemAccountCache(company);
    await pool.query('DELETE FROM reclassification_batch_lines WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM reclassification_batches WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_journal_lines WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_account_balances WHERE fiscal_period_id IN (SELECT id FROM fiscal_periods WHERE company_id=$1)', [company]);
    await pool.query('DELETE FROM gl_journal_entries WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM fiscal_periods WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_accounts WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=$1', [company]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

async function creditLessDebit(period: string): Promise<Record<string, number>> {
  const rows = (await getTrialBalanceReport(company, period)).rows;
  return Object.fromEntries(rows.map((r) => [r.accountCode, r.creditBalance - r.debitBalance]));
}

describe('G-01: reclassifying after the close', () => {
  it('the preview, the posted batch and the trial balance agree, and the close is skipped', async () => {
    await closeFiscalYear(company, '2025', user);
    const closing = await pool.query(
      "SELECT jl.id FROM gl_journal_lines jl JOIN gl_journal_entries je ON je.id=jl.journal_entry_id WHERE je.company_id=$1 AND je.source='year_end' AND jl.gl_account_id=$2",
      [company, revenue]);
    expect(closing.rows).toHaveLength(1);

    const prev = JSON.parse((await proposeReclassificationTool.handler(args, ctx)).content[0]!.text);
    const row = (code: string) => prev.account_movement.find((a: { accountCode: string }) => a.accountCode === code);
    const after = (code: string) => row(code).after;
    // The preview's own before/after read the ledger without the close too (impact.ts): 1750 + 600 on 4000.
    expect(row('4000').before).toBe(2350);
    expect(prev.profit_and_loss_before.revenue).toBe(2350);
    expect(after('4100')).toBe(1750);
    expect(JSON.stringify(prev)).toContain('year_end_close');

    const client = await getPoolForTests().connect();
    try {
      await client.query('BEGIN');
      const result = await als.run(
        { client, userId: user, companyId: company, claims: {} } as unknown as Parameters<typeof als.run>[0],
        () => postReclassificationBatchTool.handler({ ...args, idempotency_key: crypto.randomUUID() }, ctx),
      );
      await client.query('COMMIT');
      expect(result.isError).not.toBe(true);
    } finally { (client as PoolClient).release(); }

    // The closing line was not touched: no reclassification journal names it.
    const moved = await pool.query(
      'SELECT count(*)::int AS n FROM reclassification_batch_lines WHERE company_id=$1 AND source_line_id=$2',
      [company, closing.rows[0].id]);
    expect(moved.rows[0].n).toBe(0);

    const tb = await creditLessDebit(p26);
    expect({ preview4100: after('4100'), tb4100: tb['4100'], tb4000: tb['4000'] })
      .toEqual({ preview4100: 1750, tb4100: 1750, tb4000: 600 - 1750 });
  }, 60000);

  it('dimension tagging refuses the closing journal\'s lines', async () => {
    const line = await pool.query(
      "SELECT jl.id FROM gl_journal_lines jl JOIN gl_journal_entries je ON je.id=jl.journal_entry_id WHERE je.company_id=$1 AND je.source='year_end' LIMIT 1",
      [company]);
    await expect(planDimensionTags(company, [{ journalLineId: line.rows[0].id, cc1: null }]))
      .rejects.toThrow(/year-end/i);
  });
});
