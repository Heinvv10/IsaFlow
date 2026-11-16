/**
 * Fixture for the period-close readiness gate suites: a company with FY2026
 * (Jan–Dec) and one posted January journal, nothing else outstanding; the
 * failing check is bank_reconciled on master's definition (a posted bank line
 * still `imported` in the period), fixed by reconciling the line.
 */
import type { Pool } from 'pg';
import fiscalPeriodsAction from '../../../pages/api/accounting/fiscal-periods-action';
import yearEnd from '../../../pages/api/accounting/year-end';
import { callRoute } from '../r035-approval.helpers';
import { newCompany } from '../entity-changes.helpers';
import { plantFiscalYear, plantJournal, plantLedger, type Ledger } from '../audit-snapshots.helpers';

export interface Books { c: string; l: Ledger; periods: string[] }

export function gateFixture(pool: Pool, companies: string[], tokens: Record<string, string>) {
  const fx = {
    owner: '',
    /** A company with FY2026 (Jan–Dec), one posted journal in January, and nothing else outstanding. */
    async books(members: [string, string][] = [[fx.owner, 'owner']]): Promise<Books> {
      const c = await newCompany(pool, members, companies);
      await pool.query('UPDATE companies SET financial_year_start = 1 WHERE id = $1', [c]);
      const l = await plantLedger(pool, c);
      const periods = await plantFiscalYear(pool, c, 2026, '2026-01-01');
      await plantJournal(pool, c, { date: '2026-01-15', amount: 100, debit: l.bank, credit: l.sales, by: fx.owner });
      return { c, l, periods };
    },
    /** One imported (unreconciled) bank line dated `date`: bank_reconciled fails for its period. */
    async unreconciledLine(b: Books, date: string): Promise<string> {
      const id = crypto.randomUUID();
      await pool.query(
        `INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount,description,status)
         VALUES($1,$2,$3,$4::DATE,-250,'gate line','imported')`, [id, b.c, b.l.bank, date]);
      return id;
    },
    reconcile: (id: string) => pool.query("UPDATE bank_transactions SET status = 'reconciled' WHERE id = $1", [id]),
    action: (c: string, body: Record<string, unknown>, user = fx.owner) =>
      callRoute(fiscalPeriodsAction, tokens[user]!, c, 'POST', body, '/api/accounting/fiscal-periods-action'),
    yearEndClose: (c: string, user = fx.owner) => callRoute(yearEnd, tokens[user]!, c, 'POST',
      { action: 'close', yearLabel: '2026', confirm: true }, '/api/accounting/year-end'),
    /** A retained-earnings system account, which the year-end close needs. */
    retainedEarnings: (c: string) => pool.query(
      `INSERT INTO gl_accounts(company_id,account_code,account_name,account_type,normal_balance,is_system_account,account_subtype)
       VALUES($1,'3100','Retained earnings','equity','credit',true,'retained_earnings')`, [c]),
    statuses: async (c: string) =>
      (await pool.query('SELECT status FROM fiscal_periods WHERE company_id = $1 ORDER BY period_number', [c])).rows
        .map((r) => r.status as string),
  };
  return fx;
}

export type Details = {
  code: string; fiscalYear?: number;
  periods: Array<{ periodId: string; periodName: string; blockers: Array<Record<string, string>> }>;
};
export const details = (body: unknown) => (body as { error: { details: Details } }).error.details;
