/**
 * Twelve monthly figures per account, footed against the statements they sit
 * beside.
 *
 * Runs against a real DATABASE_URL. This is NOT a skip-when-no-DB test: with
 * no DATABASE_URL it FAILS, because a green suite that proved nothing is how
 * the reporting surfaces got into the state Phase 1 had to repair.
 *
 * The footing is deliberately against `getIncomeStatement` and
 * `getBalanceSheet` rather than against a hand-written SUM in the test. A
 * sparkline printed next to a statement line has one job: to describe THAT
 * number over time. A second aggregation written in the test would agree with
 * the service and still disagree with the statement — which is the whole
 * defect. The balance sheet signs by `normal_balance` and negates
 * contra-assets; a plain debit-less-credit series would draw Accumulated
 * Depreciation upside down against the figure printed next to it.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { sql } from '@/lib/neon';
import { getIncomeStatement } from '@/modules/accounting/services/reports/incomeStatementService';
import { getBalanceSheet } from '@/modules/accounting/services/reports/balanceSheetService';
import { getSystemAccount } from '@/modules/accounting/services/gl/systemAccountResolver';
import {
  getMonthlyMovements,
  getMonthlyBalances,
} from '@/modules/accounting/services/reports/trendRowsService';

const AS_OF = '2026-08-31';

const TENANTS: Array<{ name: string; id: string }> = [
  { name: 'ISAFlow Demo', id: '00000000-0000-0000-0000-000000000001' },
  { name: 'Brightsphere', id: 'd27bac33-cdc0-4e58-bf6b-709c1597d41c' },
];

beforeAll(async () => {
  const url = process.env['DATABASE_URL'] ?? '';
  if (!url || url.includes('dummy')) {
    throw new Error('accountTrends.int.test needs a real DATABASE_URL');
  }
  for (const t of TENANTS) {
    const rows = (await sql`
      SELECT id FROM companies WHERE id = ${t.id}::UUID
    `) as Array<{ id: string }>;
    expect(rows.length, `tenant ${t.name} missing from this database`).toBe(1);
  }
});

/**
 * The last month inside the window with a posted entry that reaches the INCOME
 * STATEMENT, as `YYYY-MM`. Restricted to revenue and expense lines: the newest
 * entry in a month may be a balance-sheet-only journal (a bank transfer, a
 * receipt), and footing the movement series against an income statement that
 * has no lines at all proves nothing.
 */
async function lastPostedMonth(companyId: string, months: string[]): Promise<string | null> {
  const rows = (await sql`
    SELECT to_char(MAX(je.entry_date), 'YYYY-MM') AS month_key
    FROM gl_journal_lines jl
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
    JOIN gl_accounts ga ON ga.id = jl.gl_account_id
    WHERE jl.company_id = ${companyId}::UUID
      AND je.company_id = ${companyId}::UUID
      AND ga.company_id = ${companyId}::UUID
      AND je.status = 'posted'
      AND ga.account_type IN ('revenue', 'expense')
      AND je.entry_date >= ${`${months[0]}-01`}::date
      AND je.entry_date <= ${AS_OF}::date
  `) as Array<{ month_key: string | null }>;
  return rows[0]?.month_key ?? null;
}

/**
 * Account codes the balance sheet cannot agree with, because it reads them
 * through ANOTHER tenant's `gl_accounts` row.
 *
 * `fetchBalanceSheetData` joins `gl_accounts ga ON ga.id = jl.gl_account_id`
 * with no `ga.company_id` predicate, so a journal line pointing at a foreign
 * account row is still banded and printed. The trend service scopes all three
 * tables (mig 329), so those lines are absent from it — correctly. One such
 * line exists in this database: Brightsphere carries R450 on a `1140 VAT
 * Input` row owned by company 9f4cccf9. Derived here rather than hardcoded, so
 * the exemption tracks the data instead of hiding a regression.
 */
async function codesReadThroughForeignAccounts(companyId: string): Promise<Set<string>> {
  const rows = (await sql`
    SELECT DISTINCT ga.account_code
    FROM gl_journal_lines jl
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
    JOIN gl_accounts ga ON ga.id = jl.gl_account_id
    WHERE jl.company_id = ${companyId}::UUID
      AND je.company_id = ${companyId}::UUID
      AND ga.company_id <> ${companyId}::UUID
      AND je.status = 'posted'
      AND je.entry_date <= ${AS_OF}::date
  `) as Array<{ account_code: string }>;
  return new Set(rows.map((r) => r.account_code));
}

function monthEnd(monthKey: string): string {
  const [y, m] = monthKey.split('-').map(Number);
  return new Date(Date.UTC(y!, m!, 0)).toISOString().slice(0, 10);
}

describe.each(TENANTS)('account trends — $name', ({ id: companyId }) => {
  it('returns exactly twelve months, in ascending order, ending at the as-of month', async () => {
    for (const trends of [
      await getMonthlyMovements(companyId, AS_OF),
      await getMonthlyBalances(companyId, AS_OF),
    ]) {
      expect(trends.months).toHaveLength(12);
      expect([...trends.months].sort()).toEqual(trends.months);
      expect(trends.months[11]).toBe('2026-08');
      expect(trends.months[0]).toBe('2025-09');
    }
  });

  it('gives every account exactly twelve finite figures', async () => {
    for (const trends of [
      await getMonthlyMovements(companyId, AS_OF),
      await getMonthlyBalances(companyId, AS_OF),
    ]) {
      const series = Object.values(trends.byAccountCode);
      expect(series.length).toBeGreaterThan(0);
      for (const values of series) {
        expect(values).toHaveLength(12);
        expect(values.every(Number.isFinite)).toBe(true);
      }
    }
  });

  it('returns only this tenant’s account codes', async () => {
    const owned = (await sql`
      SELECT account_code FROM gl_accounts WHERE company_id = ${companyId}::UUID
    `) as Array<{ account_code: string }>;
    const ownedCodes = new Set(owned.map((r) => r.account_code));
    expect(ownedCodes.size).toBeGreaterThan(0);

    const movements = await getMonthlyMovements(companyId, AS_OF);
    const balances = await getMonthlyBalances(companyId, AS_OF);
    for (const code of [...Object.keys(movements.byAccountCode), ...Object.keys(balances.byAccountCode)]) {
      expect(ownedCodes.has(code), `code ${code} is not this tenant's`).toBe(true);
    }
  });

  it('movement foots: every account’s month equals the income statement for that month', async () => {
    const trends = await getMonthlyMovements(companyId, AS_OF);
    const month = await lastPostedMonth(companyId, trends.months);
    expect(month, 'no posted entries inside the trend window').not.toBeNull();
    const slot = trends.months.indexOf(month!);
    expect(slot).toBeGreaterThanOrEqual(0);

    const is = await getIncomeStatement(companyId, `${month}-01`, monthEnd(month!));
    const statement = new Map<string, number>();
    for (const line of [
      ...is.revenue, ...is.otherIncome,
      ...is.costOfSales, ...is.operatingExpenses, ...is.otherExpenses,
    ]) {
      statement.set(line.accountCode, (statement.get(line.accountCode) ?? 0) + line.amount);
    }
    expect(statement.size, `income statement is empty for ${month}`).toBeGreaterThan(0);

    for (const [code, amount] of statement) {
      expect(trends.byAccountCode[code], `no trend series for ${code}`).toBeDefined();
      expect(trends.byAccountCode[code]![slot], `movement for ${code} in ${month}`).toBeCloseTo(amount, 2);
    }
  });

  it('balance foots: the last month equals the balance sheet at as-of', async () => {
    const trends = await getMonthlyBalances(companyId, AS_OF);
    const bs = await getBalanceSheet(companyId, AS_OF);
    // The balance sheet INJECTS derived retained earnings onto this account,
    // which is a P&L residual and not a posting to the account. The trend must
    // refuse the series rather than draw the posted lines, which are flat at
    // zero next to a printed figure in the millions.
    const re = await getSystemAccount('retained_earnings', companyId);
    expect(trends.byAccountCode[re.accountCode]).toBeUndefined();
    expect(trends.unavailable[re.accountCode]).toBe('derived on the balance sheet');

    const foreign = await codesReadThroughForeignAccounts(companyId);

    const lines = [...bs.assets, ...bs.liabilities, ...bs.equity]
      .filter((l) => l.accountCode !== re.accountCode && !foreign.has(l.accountCode));
    expect(lines.length, 'balance sheet is empty at as-of').toBeGreaterThan(0);

    for (const line of lines) {
      expect(trends.byAccountCode[line.accountCode], `no trend series for ${line.accountCode}`).toBeDefined();
      expect(
        trends.byAccountCode[line.accountCode]![11],
        `balance for ${line.accountCode} at ${AS_OF}`,
      ).toBeCloseTo(line.balance, 2);
    }
  });

  it('balance foots mid-window too: month 6 equals the balance sheet at that month end', async () => {
    const trends = await getMonthlyBalances(companyId, AS_OF);
    const month = trends.months[5]!;
    const bs = await getBalanceSheet(companyId, monthEnd(month));
    const re = await getSystemAccount('retained_earnings', companyId);
    const foreign = await codesReadThroughForeignAccounts(companyId);

    expect(trends.unavailable[re.accountCode]).toBe('derived on the balance sheet');

    for (const line of [...bs.assets, ...bs.liabilities, ...bs.equity]) {
      if (line.accountCode === re.accountCode || foreign.has(line.accountCode)) continue;
      expect(trends.byAccountCode[line.accountCode], `no trend series for ${line.accountCode}`).toBeDefined();
      expect(
        trends.byAccountCode[line.accountCode]![5],
        `balance for ${line.accountCode} at ${monthEnd(month)}`,
      ).toBeCloseTo(line.balance, 2);
    }
  });

  it('an account with no ledger activity gets no series at all', async () => {
    const idle = (await sql`
      SELECT ga.account_code, ga.account_type
      FROM gl_accounts ga
      WHERE ga.company_id = ${companyId}::UUID
        AND NOT EXISTS (
          SELECT 1 FROM gl_journal_lines jl
          JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
          WHERE jl.gl_account_id = ga.id
            AND jl.company_id = ${companyId}::UUID
            AND je.company_id = ${companyId}::UUID
            AND je.status = 'posted'
            AND je.entry_date <= ${AS_OF}::date
        )
      LIMIT 50
    `) as Array<{ account_code: string; account_type: string }>;
    expect(idle.length, 'no idle account in this chart to prove absence').toBeGreaterThan(0);

    const movements = await getMonthlyMovements(companyId, AS_OF);
    const balances = await getMonthlyBalances(companyId, AS_OF);
    for (const account of idle) {
      // An empty series is a claim — "this account sat at zero all year". An
      // account nothing was ever posted to has no such claim to make.
      expect(movements.byAccountCode[account.account_code], `movement series for idle ${account.account_code}`).toBeUndefined();
      expect(balances.byAccountCode[account.account_code], `balance series for idle ${account.account_code}`).toBeUndefined();
    }
  });

  it('balances carry forward: a quiet month repeats the month before it', async () => {
    const trends = await getMonthlyBalances(companyId, AS_OF);
    const moved = (await sql`
      SELECT ga.account_code,
             to_char(date_trunc('month', je.entry_date), 'YYYY-MM') AS month_key
      FROM gl_journal_lines jl
      JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
      JOIN gl_accounts ga ON ga.id = jl.gl_account_id
      WHERE jl.company_id = ${companyId}::UUID
        AND je.company_id = ${companyId}::UUID
        AND ga.company_id = ${companyId}::UUID
        AND je.status = 'posted'
        AND ga.account_type IN ('asset', 'liability', 'equity')
        AND je.entry_date >= ${`${trends.months[0]}-01`}::date
        AND je.entry_date <= ${AS_OF}::date
      GROUP BY 1, 2
    `) as Array<{ account_code: string; month_key: string }>;
    const active = new Set(moved.map((r) => `${r.account_code}|${r.month_key}`));

    let quietMonths = 0;
    for (const [code, values] of Object.entries(trends.byAccountCode)) {
      for (let i = 1; i < 12; i++) {
        if (active.has(`${code}|${trends.months[i]}`)) continue;
        quietMonths++;
        expect(values[i], `${code} in ${trends.months[i]} should carry ${values[i - 1]}`)
          .toBeCloseTo(values[i - 1]!, 2);
      }
    }
    expect(quietMonths, 'no quiet month in this data to prove carry-forward').toBeGreaterThan(0);
  });
});
