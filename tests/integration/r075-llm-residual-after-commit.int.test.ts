/**
 * R-075 twin — smart-categorize's LLM residual pass.
 *
 * The route used to `void runLlmResidualPass(...)` inside withAuth, so the
 * pass's writes — including the auto-post sweep's JOURNALS — went through the
 * request's released connection, like capture routeEvent's. It now starts after
 * the request commits, via runAfterCommit, with no request transaction at all.
 *
 * That exposes a dependency the old wandering path hid: the sweep posts through
 * allocateTransaction, whose FOR UPDATE row lock refuses to run without a
 * request transaction ("requires a request transaction"). So buildRunDeps gives
 * the sweep its own ALS-bound transaction. This drives the whole pass exactly as
 * the after-commit callback does — outside any ALS store — and requires the row
 * to POST, not merely be tagged.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { als } from '@/lib/als';
import { buildRunDeps, runLlmResidualPass } from '@/modules/accounting/services/bank/llmCategorizationPass';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const COMPANY = randomUUID();
const USER = randomUUID();
let admin: Pool;
let bankAccount = '';
let expenseAccount = '';
let txId = '';

async function acct(code: string, name: string, type: string, subtype: string, normal: string) {
  const r = await admin.query(
    `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type,
       account_subtype, normal_balance, is_active, is_system_account)
     VALUES ($1,$2,$3,$4,$5,$6,true,true) RETURNING id`,
    [COMPANY, code, name, type, subtype, normal]);
  return r.rows[0].id as string;
}

describeIfDb('R-075 the LLM residual pass posts when it runs after the request commits', () => {
  beforeAll(async () => {
    const dbName = new URL(DATABASE_URL!).pathname.replace(/^\//, '');
    if (dbName === 'isaflow') throw new Error('Refusing to run against production.');
    admin = new Pool({ connectionString: DATABASE_URL, max: 3 });
    await admin.query(`INSERT INTO companies (id,name,is_active) VALUES ($1,'R075 LLM Fixture',true)`, [COMPANY]);
    bankAccount = await acct('1000', 'R075 Bank', 'asset', 'bank', 'debit');
    expenseAccount = await acct('6000', 'R075 Expense', 'expense', 'default_expense', 'debit');
    await acct('2100', 'R075 AP', 'liability', 'payable', 'credit');
    await admin.query(
      `INSERT INTO gl_fiscal_periods (company_id, period_name, start_date, end_date, status)
       VALUES ($1,'R075 2026-03','2026-03-01','2026-03-31','open') ON CONFLICT DO NOTHING`, [COMPANY])
      .catch(() => undefined); // absent on some schemas; the posting path resolves its own period (as K-140)
    await admin.query(
      `INSERT INTO bank_auto_post_settings
         (company_id, enabled, min_confidence, amount_cap, llm_enabled, llm_min_confidence, llm_amount_cap, updated_at)
       VALUES ($1, false, 0.95, 0, true, 0.80, 2000, NOW())`, [COMPANY]);
    const tx = await admin.query(
      `INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date, amount, description, status)
       VALUES ($1,$2,'2026-03-10',-100,'R075 residual row','imported') RETURNING id`, [COMPANY, bankAccount]);
    txId = tx.rows[0].id;
  }, 60000);

  afterAll(async () => {
    if (!admin) return;
    await admin.query('DELETE FROM bank_transactions WHERE company_id = $1', [COMPANY]);
    await admin.query('DELETE FROM bank_auto_post_settings WHERE company_id = $1', [COMPANY]);
    await admin.query('DELETE FROM bank_auto_post_runs WHERE company_id = $1', [COMPANY]);
    await admin.query('DELETE FROM gl_journal_lines WHERE company_id = $1', [COMPANY]);
    await admin.query('DELETE FROM gl_journal_entries WHERE company_id = $1', [COMPANY]);
    await admin.query(
      'DELETE FROM gl_account_balances WHERE gl_account_id IN (SELECT id FROM gl_accounts WHERE company_id = $1)',
      [COMPANY]);
    await admin.query('DELETE FROM gl_fiscal_periods WHERE company_id = $1', [COMPANY]).catch(() => undefined);
    await admin.query('DELETE FROM fiscal_periods WHERE company_id = $1', [COMPANY]).catch(() => undefined);
    await admin.query('DELETE FROM gl_fiscal_years WHERE company_id = $1', [COMPANY]).catch(() => undefined);
    await admin.query('DELETE FROM gl_accounts WHERE company_id = $1', [COMPANY]);
    await admin.query('DELETE FROM companies WHERE id = $1', [COMPANY]);
    await admin.end();
  });

  it('tags the residual row AND posts it, with no request transaction in scope', async () => {
    expect(als.getStore()).toBeUndefined();
    const deps = await buildRunDeps(COMPANY, USER, [txId]);
    await runLlmResidualPass(COMPANY, [txId], USER, {
      ...deps,
      // The Anthropic call is the only thing replaced.
      categorizeOne: async () => ({
        glAccountId: expenseAccount, confidence: 0.97, accountCode: '6000', accountName: 'R075 Expense',
      }),
    });

    const row = (await admin.query(
      `SELECT status, suggested_strategy, auto_post_run_id, matched_journal_line_id
         FROM bank_transactions WHERE id = $1`, [txId])).rows[0];
    expect(row.suggested_strategy).toBe('llm');
    expect(row.status).toBe('allocated');
    expect(row.auto_post_run_id).not.toBeNull();
    const posted = (await admin.query(
      `SELECT count(*)::int AS n FROM gl_journal_entries WHERE company_id = $1 AND status = 'posted'`,
      [COMPANY])).rows[0].n;
    expect(posted).toBe(1);
  }, 60000);
});
