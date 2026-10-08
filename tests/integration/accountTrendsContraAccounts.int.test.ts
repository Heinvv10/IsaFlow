/**
 * The trend series beside a contra account must equal the figure printed next to it. The balance sheet signs by
 * SECTION (assets debit − credit; liabilities and equity credit − debit), so Dividends Declared / Drawings
 * (debit-normal equity) print NEGATIVE; a series signed by the account's normal side drew them positive
 * (isaflow_dev 2026-10-07: Sample Trading 3400 printed -2,534,865.85, trended +2,534,865.85).
 *
 * Runs against a real DATABASE_URL, read-only, like accountTrends.int.test.ts. It needs at least one company with a
 * debit-normal equity or liability balance and FAILS (not skips) without one, so it cannot pass by proving nothing.
 */
import { describe, it, expect } from 'vitest';
import { sql } from '@/lib/neon';
import { getBalanceSheet } from '@/modules/accounting/services/reports/balanceSheetService';
import { getMonthlyBalances } from '@/modules/accounting/services/reports/trendRowsService';

function monthEnd(monthKey: string): string {
  const [y, m] = monthKey.split('-').map(Number);
  return new Date(Date.UTC(y!, m!, 0)).toISOString().slice(0, 10);
}

describe('account trends — contra equity / liability accounts', () => {
  it('the last month of a debit-normal equity/liability series equals its balance-sheet line', async () => {
    const url = process.env['DATABASE_URL'] ?? '';
    if (!url || url.includes('dummy')) throw new Error('accountTrendsContraAccounts.int.test needs a real DATABASE_URL');

    // Accounts the company owns itself (foreign-account lines are exempt in accountTrends.int.test too).
    const contra = (await sql`
      SELECT je.company_id, ga.account_code, to_char(MAX(je.entry_date), 'YYYY-MM') AS last_month
      FROM gl_journal_lines jl
      JOIN gl_journal_entries je ON je.id = jl.journal_entry_id AND je.status = 'posted'
      JOIN gl_accounts ga ON ga.id = jl.gl_account_id AND ga.company_id = je.company_id
      WHERE jl.company_id = je.company_id
        AND ga.account_type IN ('equity', 'liability') AND ga.normal_balance = 'debit'
        AND je.entry_date <= '2199-12-31'
      GROUP BY je.company_id, ga.account_code
      HAVING ABS(SUM(jl.debit - jl.credit)) > 0.01
      ORDER BY je.company_id, ga.account_code
      LIMIT 5
    `) as Array<{ company_id: string; account_code: string; last_month: string }>;
    expect(contra.length, 'no company in this database holds a debit-normal equity/liability balance').toBeGreaterThan(0);

    for (const c of contra) {
      const asOf = monthEnd(c.last_month);
      const trends = await getMonthlyBalances(c.company_id, asOf);
      const bs = await getBalanceSheet(c.company_id, asOf);
      const line = [...bs.liabilities, ...bs.equity].find((l) => l.accountCode === c.account_code);
      expect(line, `${c.company_id} ${c.account_code} is not on the balance sheet at ${asOf}`).toBeDefined();
      expect(trends.byAccountCode[c.account_code]![11], `${c.company_id} ${c.account_code} at ${asOf}`)
        .toBeCloseTo(line!.balance, 2);
    }
  }, 120000);
});
