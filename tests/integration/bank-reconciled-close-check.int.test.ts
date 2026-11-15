// Period close: the bank_reconciled readiness check counts the period's unreconciled bank lines by the shared
// definition (bank/unreconciledLineSql, Hein 2026-11-15): a posted line neither reconciled nor excluded. Before, it
// counted only 'imported' and 'matched', so a period whose lines were allocated (or provisional) but never reconciled
// passed with "All bank transactions in this period are reconciled or excluded" (the breaker's repro on #1442).
// A 'fail' blocks close_fiscal_period (closePeriodWithReadiness); period_close_checklist and the Month-End close run
// carry the same reason.
//
// Fixture, one bank account, period June 2025. Passing set first:
//   K  reconciled          S  reconciled (Sage, no recon)   X  excluded
//   N  imported, pending   M  imported, removed             J  allocated, dated July (outside the period)
// then the blocking lines are added one at a time:
//   B  allocated (own journal), reviewed      P  provisional
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { bankReconciledCheck } from '@/modules/accounting/services/gl/closeReadinessChecks/bankReconciledCheck';
import { getCloseReadiness } from '@/modules/accounting/services/gl/periodCloseReadinessService';
import { closePeriodWithReadiness, PeriodCloseBlockedError } from '@/modules/accounting/services/gl/fiscalPeriodCloseService';
import { buildProposals } from '@/modules/accounting/services/gl/closeRun/closeRunProposalBuilder';
import { periodCloseChecklistTool } from '@/lib/mcp/tools/fiscalPeriods';
import { closeFiscalPeriodTool } from '@/lib/mcp/tools/writeFiscalPeriods';
import type { McpToolContext } from '@/lib/mcp/types';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const uuid = () => crypto.randomUUID();
const [company, user, bank, contra, period, conn] = [uuid(), uuid(), uuid(), uuid(), uuid(), uuid()];
const JUNE = { startDate: '2025-06-01', endDate: '2025-06-30' };
const ctx: McpToolContext = { userId: user, companyId: company, scopes: [], tokenJti: null, oauthAppId: null, companyRole: 'admin' };
const text = (r: { content: Array<{ text?: string }> }) => r.content.map((c) => c.text ?? '').join('');

async function journal(amount: number): Promise<string> {
  const je = uuid();
  await pool.query(
    `INSERT INTO gl_journal_entries(id,company_id,entry_date,description,status,created_by,fiscal_period_id,posted_at,posted_by)
     VALUES($1,$2,'2025-06-10','close-check fixture','posted',$3,$4,NOW(),$3)`, [je, company, user, period]);
  const jl = uuid();
  await pool.query(
    `INSERT INTO gl_journal_lines(id,company_id,journal_entry_id,gl_account_id,debit,credit)
     VALUES($1,$2,$3,$4,$5,0),($6,$2,$3,$7,0,$5)`, [jl, company, je, bank, amount, uuid(), contra]);
  return jl;
}

async function line(status: string, o: { date?: string; feed?: string; journal?: boolean; reviewed?: boolean } = {}) {
  const feed = o.feed ?? 'posted';
  await pool.query(
    `INSERT INTO bank_transactions(company_id,bank_account_id,transaction_date,amount,description,status,
       matched_journal_line_id,reviewed_at,allocation_type,feed_state,bank_feed_connection_id,provider_transaction_id)
     VALUES($1,$2,$3::DATE,10,'close-check fixture',$4,$5,$6,$7,$8,$9,$10)`,
    [company, bank, o.date ?? '2025-06-10', status, o.journal ? await journal(10) : null, o.reviewed ? new Date() : null,
      status === 'allocated' ? 'account' : null, feed, feed === 'posted' ? null : conn,
      feed === 'posted' ? null : `close-${uuid()}`]);
}

const check = () => bankReconciledCheck(company, JUNE);
const bankItem = async () => (await getCloseReadiness(company, period))!.items.find((i) => i.key === 'bank_reconciled')!;

describe('bank_reconciled close check: every posted line in the period that is not reconciled or excluded blocks', () => {
  beforeAll(async () => {
    await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'Close-check fixture']);
    await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
    await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')", [company, user]);
    await pool.query(
      `INSERT INTO fiscal_periods(id,company_id,period_name,period_number,fiscal_year,start_date,end_date,status)
       VALUES($1,$2,'CC Jun',1,2025,'2025-06-01','2025-06-30','open')`, [period, company]);
    await pool.query(
      `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance)
       VALUES($1,$3,'CCB','CC Bank','asset','bank','debit'),($2,$3,'CCC','CC Contra','revenue',NULL,'credit')`,
      [bank, contra, company]);
    await pool.query(
      `INSERT INTO bank_feed_connections(id,company_id,bank_account_id,provider,status,is_active)
       VALUES($1,$2,$3,'test_provider','active',true)`, [conn, company, bank]);
    await line('reconciled', { journal: true, reviewed: true });
    await line('reconciled');
    await line('excluded');
    await line('imported', { feed: 'pending' });
    await line('imported', { feed: 'removed' });
    await line('allocated', { date: '2025-07-01', journal: true });
  });

  afterAll(async () => {
    try {
      await pool.query('DELETE FROM bank_transactions WHERE company_id=$1', [company]);
      await pool.query('DELETE FROM bank_feed_connections WHERE company_id=$1', [company]);
      await pool.query('DELETE FROM gl_journal_lines WHERE company_id=$1', [company]);
      await pool.query('DELETE FROM gl_journal_entries WHERE company_id=$1', [company]);
      await pool.query('DELETE FROM gl_account_balances WHERE gl_account_id=ANY($1::uuid[])', [[bank, contra]]);
      await pool.query('DELETE FROM gl_accounts WHERE company_id=$1', [company]);
      await pool.query('DELETE FROM fiscal_periods WHERE company_id=$1', [company]);
      await pool.query('DELETE FROM company_users WHERE company_id=$1', [company]);
      await pool.query('DELETE FROM companies WHERE id=$1', [company]);
      await pool.query('DELETE FROM users WHERE id=$1', [user]);
    } finally { await pool.end(); }
  });

  it('passes when the period holds only reconciled, excluded, pending and removed lines (and one outside it)', async () => {
    expect(await check()).toMatchObject({
      key: 'bank_reconciled', status: 'pass',
      reason: 'Every bank transaction in this period is reconciled or excluded.',
    });
  });

  it('fails on one posted allocated line, reviewed or not, and says what clears it', async () => {
    await line('allocated', { journal: true, reviewed: true });
    expect(await check()).toEqual({
      key: 'bank_reconciled', label: 'Bank reconciled', status: 'fail',
      reason: '1 unreconciled bank transaction remains in this period. Allocating or reviewing a line does not '
        + 'reconcile it: complete a bank reconciliation that covers it, or exclude it.',
      fixHref: '/accounting/bank-reconciliation',
    });
  });

  it('counts a provisional line too', async () => {
    await line('provisional');
    expect((await check()).reason).toMatch(/^2 unreconciled bank transactions remain in this period\. /);
  });

  it('the readiness checklist and the Month-End close run carry the failing check and its reason', async () => {
    const item = await bankItem();
    expect(item.status).toBe('fail');
    const readiness = (await getCloseReadiness(company, period))!;
    const proposal = buildProposals(readiness, { draftJournals: [], unpostedCount: 0 })
      .find((p) => p.kind === 'bank_unreconciled');
    expect(JSON.stringify(proposal)).toContain('2 unreconciled bank transactions remain in this period');
  });

  it('close_fiscal_period refuses, live and dry run, naming bank_reconciled and its reason; nothing is closed', async () => {
    const err = await closePeriodWithReadiness(company, period, user, { dryRun: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PeriodCloseBlockedError);
    expect((err as PeriodCloseBlockedError).blockers.map((b) => b.key)).toContain('bank_reconciled');
    const live = await closeFiscalPeriodTool.handler({ fiscal_period_id: period, idempotency_key: uuid() }, ctx);
    expect(live.isError).toBe(true);
    expect(text(live)).toContain('bank_reconciled: 2 unreconciled bank transactions remain in this period');
    const [p] = (await pool.query('SELECT status FROM fiscal_periods WHERE id=$1', [period])).rows;
    expect(p.status).toBe('open');
  });

  it('period_close_checklist reports it as fail with the same reason and the reconciliation screen', async () => {
    const out = JSON.parse(text(await periodCloseChecklistTool.handler({ fiscal_period_id: period }, ctx)));
    expect(out.items.find((i: { key: string }) => i.key === 'bank_reconciled')).toMatchObject({
      status: 'fail', fix_href: '/accounting/bank-reconciliation',
      reason: expect.stringMatching(/^2 unreconciled bank transactions remain in this period\. /),
    });
  });
});
