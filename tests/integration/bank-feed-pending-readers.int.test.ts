import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID();
const user = crypto.randomUUID();
const bank = crypto.randomUUID();
const conn = crypto.randomUUID();

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'BFPR company']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await pool.query(
    `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance,account_subtype,is_active)
     VALUES($1,$2,'1110','BFPR Bank','asset','debit','bank',true)`, [bank, company]);
  await pool.query(
    `INSERT INTO bank_feed_connections(id,company_id,bank_account_id,provider,status,is_active)
     VALUES($1,$2,$3,'test_provider','active',true)`, [conn, company, bank]);
  const ins = (amount: number, state: string, pid: string | null) => pool.query(
    `INSERT INTO bank_transactions(company_id,bank_account_id,transaction_date,amount,description,
       bank_feed_connection_id,provider_transaction_id,feed_state)
     VALUES($1,$2,'2026-09-03',$3,'BFPR',$4,$5,$6)`,
    [company, bank, amount, pid ? conn : null, pid, state]);
  await ins(-100, 'posted', null);
  await ins(-30, 'pending', 'bfpr-pending');
  await ins(-7, 'removed', 'bfpr-removed');
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM bank_transactions WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM bank_feed_connections WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_accounts WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=$1', [company]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

async function inRequest<T>(fn: () => Promise<T>): Promise<T> {
  const { als } = await import('@/lib/als');
  const client: PoolClient = await pool.connect();
  try {
    await client.query('BEGIN');
    return await als.run({ client, userId: user, companyId: company, claims: {} }, fn);
  } finally { await client.query('ROLLBACK'); client.release(); }
}

describe('readers', () => {
  it('cash statement balance counts only posted rows', async () => {
    const { getBankAccountsStatus } = await import('@/modules/accounting/services/bank/bankAccountStatusService');
    const accounts = await inRequest(() => getBankAccountsStatus(company));
    const acct = (accounts as Array<{ id?: string; accountId?: string; balance?: number; txnCount?: number }>)
      .find((a) => (a.id ?? a.accountId) === bank);
    expect(acct?.balance).toBe(-100);
  });

  it('review queue shows pending, hides removed, and exposes feedState', async () => {
    const { getBankTransactions } = await import('@/modules/accounting/services/bank/bankTransactionQueryService');
    const page = await inRequest(() => getBankTransactions(company, { bankAccountId: bank, status: 'imported' }));
    const states = page.transactions.map((t) => t.feedState).sort();
    expect(states).toEqual(['pending', 'posted']);
    expect(page.total).toBe(2);
  });

  it('review queue (bankAccountId-only branch) shows pending, hides removed', async () => {
    const { getBankTransactions } = await import('@/modules/accounting/services/bank/bankTransactionQueryService');
    const page = await inRequest(() => getBankTransactions(company, { bankAccountId: bank }));
    const states = page.transactions.map((t) => t.feedState).sort();
    expect(states).toEqual(['pending', 'posted']);
    expect(page.total).toBe(2);
  });

  it('review queue (company-wide branch) shows pending, hides removed', async () => {
    const { getBankTransactions } = await import('@/modules/accounting/services/bank/bankTransactionQueryService');
    const page = await inRequest(() => getBankTransactions(company, {}));
    const states = page.transactions.map((t) => t.feedState).sort();
    expect(states).toEqual(['pending', 'posted']);
    expect(page.total).toBe(2);
  });

  it('coverage reader (fetchCoverageAccounts) counts only posted rows', async () => {
    const { fetchCoverageAccounts } = await import('@/modules/accounting/services/bank/bankCoverageQueries');
    const rows = await inRequest(() => fetchCoverageAccounts(company, '2026-09-30'));
    const acct = rows.find((r) => r.bankAccountId === bank);
    expect(acct?.transactionCount).toBe(1);
    expect(acct?.netMovement).toBe(-100);
  });

  it('KPI reader (getDashboardKPIs cash) counts only posted rows', async () => {
    const { getDashboardKPIs } = await import('@/modules/accounting/services/reports/kpiDashboardService');
    const kpis = await inRequest(() => getDashboardKPIs(company, '2026-09-01', '2026-09-30'));
    expect(kpis.cash.total).toBe(-100);
  });

  it('bankReconciledCheck counts only posted rows', async () => {
    const { bankReconciledCheck } = await import('@/modules/accounting/services/gl/closeReadinessChecks/bankReconciledCheck');
    const result = await inRequest(() => bankReconciledCheck(company, { startDate: '2026-09-01', endDate: '2026-09-30' }));
    // Only the single posted row (status defaults to 'imported') should count —
    // the pending and removed rows must not inflate this to 2 or 3.
    expect(result.status).toBe('fail');
    expect(result.reason).toContain('1 unreconciled');
  });

  it('monthEndWorkbench banking card counts only posted rows', async () => {
    const { getMonthEndWorkbench } = await import('@/modules/accounting/services/workbench/monthEndWorkbenchService');
    const workbench = await inRequest(() => getMonthEndWorkbench(company, '2026-09'));
    const banking = workbench.cards.find((c) => c.id === 'banking');
    // Only the single posted row should count as unmatched — the pending and
    // removed rows must not inflate this to 2 or 3.
    expect(banking?.primary).toBe('1 unmatched');
  });
});
