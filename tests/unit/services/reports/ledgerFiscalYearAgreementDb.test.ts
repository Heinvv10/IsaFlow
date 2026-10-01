/**
 * LED-01 (W2-04) round 1: every ledger listing of an account agrees with the
 * trial balance as at the same date — the TB, the account-detail page
 * (getAccountLedger), the inline drill-down panel (getAccountTransactions), the
 * GL report (getGeneralLedgerReport) and the MCP general_ledger stream.
 *
 * Adopts the adversarial breaker's repro cases for PR #595 (brk595Repro).
 * Connection-local temp tables in a rolled-back transaction — no persistent
 * writes; the temp tables shadow the real ones on this connection only.
 */
import { describe, expect, it, vi } from 'vitest';
import { als } from '@/lib/als';
import { getPoolForTests, sql } from '@/lib/neon';
import { getAccountLedger } from '@/modules/accounting/services/reports/accountLedgerService';
import { getAccountTransactions } from '@/modules/accounting/services/gl/transactionLedgerService';
import { getGeneralLedgerReport } from '@/modules/accounting/services/gl/generalLedgerReportService';
import { getGeneralLedgerLines } from '@/modules/accounting/services/gl/generalLedgerStreamService';
import { getIncomeStatement } from '@/modules/accounting/services/reports/incomeStatementService';
import { getTrialBalance } from '@/modules/accounting/services/gl/trialBalanceService';
import type { TrialBalanceRow } from '@/modules/accounting/types/gl.types';
import { isDbReachable } from '../../helpers/dbReachable';
import { assertNotProductionDb } from '../../../helpers/assertNotProductionDb';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

const company = '10000000-0000-4000-8000-0000000000b1';
const other = '10000000-0000-4000-8000-0000000000b2';
const SEPT = '20000000-0000-4000-8000-0000000000b1';
const FEB = '20000000-0000-4000-8000-0000000000b2';
const acct = {
  bank: '50000000-0000-4000-8000-0000000000b1',
  equity: '50000000-0000-4000-8000-0000000000b2',
  labour: '50000000-0000-4000-8000-0000000000b3',
  income: '50000000-0000-4000-8000-0000000000b4',
};
const NORMAL: Record<string, 'debit' | 'credit'> = { '1100': 'debit', '3000': 'credit', '5200': 'debit', '4300': 'credit', 'RE-BF': 'credit' };

// The breaker's fixture (5200) plus a revenue account (4300, the audit's GL-report case) and capital.
const journals: Array<[string, Array<[string, number, number]>]> = [
  ['2024-06-01', [[acct.bank, 5000, 0], [acct.equity, 0, 5000]]],
  ['2024-10-01', [[acct.labour, 7, 0], [acct.bank, 0, 7]]],
  ['2025-06-10', [[acct.labour, 1000, 0], [acct.bank, 0, 1000]]],
  ['2025-12-01', [[acct.bank, 100, 0], [acct.income, 0, 100]]],
  ['2026-02-20', [[acct.labour, 300, 0], [acct.bank, 0, 300]]],
  ['2026-04-15', [[acct.labour, 200, 0], [acct.bank, 0, 200]]],
  ['2026-05-01', [[acct.bank, 40, 0], [acct.income, 0, 40]]],
  ['2026-09-10', [[acct.labour, 50, 0], [acct.bank, 0, 50]]],
];

async function withLedger(fy: number | null, run: () => Promise<void>, otherFy: number | null = 3) {
  assertNotProductionDb('LED-01 ledger agreement');
  const client = await getPoolForTests().connect();
  try {
    await client.query('BEGIN');
    await als.run({ client, companyId: company, userId: '', claims: {} }, async () => {
      await sql`CREATE TEMP TABLE companies (id uuid, financial_year_start int) ON COMMIT DROP`;
      await sql`CREATE TEMP TABLE fiscal_periods (id uuid, company_id uuid, start_date date, end_date date) ON COMMIT DROP`;
      await sql`CREATE TEMP TABLE gl_accounts (id uuid, company_id uuid, account_code text, account_name text,
        account_type text, normal_balance text, account_subtype text) ON COMMIT DROP`;
      await sql`CREATE TEMP TABLE gl_journal_entries (id uuid, company_id uuid, status text, entry_date date,
        entry_number text, description text, reference text, source text, created_at timestamptz) ON COMMIT DROP`;
      await sql`CREATE TEMP TABLE gl_journal_lines (id uuid DEFAULT gen_random_uuid(), company_id uuid,
        journal_entry_id uuid, gl_account_id uuid, debit numeric, credit numeric, cost_center_id uuid,
        cc1_id uuid, cc2_id uuid, bu_id uuid, project_id uuid) ON COMMIT DROP`;
      await sql`INSERT INTO companies VALUES (${company}::uuid, ${fy}), (${other}::uuid, ${otherFy})`;
      await sql`INSERT INTO fiscal_periods VALUES (${SEPT}::uuid, ${company}::uuid, '2026-09-01', '2026-09-30'),
        (${FEB}::uuid, ${company}::uuid, '2026-02-01', '2026-02-28')`;
      for (const [id, code, name, type] of [
        [acct.bank, '1100', 'Bank', 'asset'], [acct.equity, '3000', 'Capital', 'equity'],
        [acct.labour, '5200', 'Labour Costs', 'expense'], [acct.income, '4300', 'Other Income', 'revenue'],
      ] as const) {
        await sql`INSERT INTO gl_accounts VALUES (${id}::uuid, ${company}::uuid, ${code}, ${name}, ${type},
          ${NORMAL[code]!}, NULL)`;
      }
      for (const [n, [date, lines]] of journals.entries()) {
        const je = `40000000-0000-4000-8000-${String(n + 1).padStart(12, '0')}`;
        await sql`INSERT INTO gl_journal_entries VALUES (${je}::uuid, ${company}::uuid, 'posted', ${date}::date,
          ${String(n + 1)}, 'Fixture', '', 'manual', ${date}::timestamptz)`;
        for (const [account, debit, credit] of lines) {
          await sql`INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit)
            VALUES (${company}::uuid, ${je}::uuid, ${account}::uuid, ${debit}, ${credit})`;
        }
      }
      await run();
    });
  } finally {
    try { await client.query('ROLLBACK'); } finally { client.release(); }
  }
}

function tbClosing(rows: TrialBalanceRow[], code: string): number {
  const row = rows.find(r => r.accountCode === code);
  if (!row) throw new Error(`TB has no row for ${code}`);
  return row.normalBalance === 'debit' ? row.debitBalance - row.creditBalance : row.creditBalance - row.debitBalance;
}
const ledger = (code: string, from: string, to = '2026-09-30') =>
  getAccountLedger({ companyId: company, accountCode: code, fromDate: from, toDate: to });
const glReport = async (code: string, from: string, to = '2026-09-30') =>
  (await getGeneralLedgerReport(company, from, to)).find(a => a.accountCode === code);

describe('ledger listings agree with the trial balance (Postgres)', async () => {
  const reachable = await isDbReachable();

  it.skipIf(!reachable)('REPRO1: the closing as at toDate does not depend on fromDate (cross-FY range)', async () => {
    await withLedger(3, async () => {
      const tb = tbClosing(await getTrialBalance(company, SEPT), '5200');
      expect(tb).toBe(250);
      for (const from of ['2026-03-01', '2026-02-28', '2026-01-01', '2024-01-01']) {
        expect((await ledger('5200', from)).periodClosingBalance).toBe(tb);
        expect((await getAccountTransactions(company, '5200', from, '2026-09-30')).closingBalance).toBe(tb);
        expect((await glReport('5200', from))?.closingBalance).toBe(tb);
      }
      const jan = await ledger('5200', '2026-01-01');
      const close = jan.rows.find(r => r.derived);
      expect(close).toMatchObject({ entryDate: '2026-02-28', credit: 1300, debit: 0, runningBalance: 0 });
      expect(close?.description).toContain('Closed to retained earnings — FY ending 2026-02-28');
      expect(jan.rows.find(r => r.entryDate === '2026-04-15')?.runningBalance).toBe(200);
      expect(jan).toMatchObject({ openingBalance: 1000, periodNet: 550, closedToRetainedEarnings: -1300, total: 4 });
    });
  });

  it.skipIf(!reachable)('REPRO2: TB, account detail, inline panel and GL report agree on one account and range', async () => {
    await withLedger(3, async () => {
      const tb = await getTrialBalance(company, SEPT);
      for (const code of ['5200', '4300', '1100']) {
        const detail = await ledger(code, '2026-09-01');
        const inline = await getAccountTransactions(company, code, '2026-09-01', '2026-09-30');
        const gl = await glReport(code, '2026-09-01');
        const want = tbClosing(tb, code);
        expect([detail.periodClosingBalance, inline.closingBalance, gl?.closingBalance]).toEqual([want, want, want]);
        expect([inline.openingBalance, gl?.openingBalance]).toEqual([detail.openingBalance, detail.openingBalance]);
      }
      expect(tbClosing(tb, '4300')).toBe(40);
    });
  });

  it.skipIf(!reachable)('movement for a one-month range equals the income statement line', async () => {
    await withLedger(3, async () => {
      const is = await getIncomeStatement(company, '2026-04-01', '2026-04-30');
      const line = [...is.operatingExpenses, ...is.costOfSales, ...is.otherExpenses].find(l => l.accountCode === '5200');
      expect(line?.amount).toBe(200);
      expect((await ledger('5200', '2026-04-01', '2026-04-30')).periodNet).toBe(line?.amount);
      expect((await getAccountTransactions(company, '5200', '2026-04-01', '2026-04-30')).periodNet).toBe(line?.amount);
    });
  });

  it.skipIf(!reachable)('GL report: retained earnings b/f keeps openings and closings netting to zero', async () => {
    await withLedger(3, async () => {
      for (const from of ['2026-09-01', '2025-01-01']) {
        const report = await getGeneralLedgerReport(company, from, '2026-09-30');
        const net = (key: 'openingBalance' | 'closingBalance') => report.reduce((s, a) =>
          s + (NORMAL[a.accountCode] === 'debit' ? a[key] : -a[key]), 0);
        expect(Math.abs(net('openingBalance'))).toBeLessThan(0.005);
        expect(Math.abs(net('closingBalance'))).toBeLessThan(0.005);
      }
      // Profit before FY 2026-03-01: 100 income − 1307 labour = −1207.
      expect((await glReport('RE-BF', '2026-09-01'))).toMatchObject({ openingBalance: -1207, derived: true });
    });
  });

  it.skipIf(!reachable)('general_ledger stream: P&L opening floored, RE-BF added, still balanced', async () => {
    await withLedger(3, async () => {
      const page = await getGeneralLedgerLines({ companyId: company, periodStart: '2026-09-01', periodEnd: '2026-09-30', limit: 100 });
      expect(page.balanced).toBe(true);
      expect(page.openingBalances).toEqual({ '5200': 200, '1100': 3633, 'RE-BF': -1207 });
      expect(page.openingBalances['5200']).toBe((await ledger('5200', '2026-09-01')).openingBalance);
      // The set holds only accounts with lines in range: 3000 (5000 cr) and 4300 (40 cr) have none in
      // September, so they are added back by hand. With RE-BF the whole opening position nets to zero.
      const inSet = Object.entries(page.openingBalances)
        .reduce((s, [code, b]) => s + (NORMAL[code] === 'debit' ? b : -b), 0);
      expect(inSet - 5000 - 40).toBeCloseTo(0, 2);
    });
  });

  it.skipIf(!reachable)('general_ledger stream across an FY start: P&L balance is null from the boundary, bank is not', async () => {
    await withLedger(3, async () => {
      // FY containing 2024-06-01 starts 2024-03-01, so the first boundary in range is 2025-03-01.
      const page = await getGeneralLedgerLines({ companyId: company, periodStart: '2024-06-01', periodEnd: '2026-09-30', limit: 100 });
      expect(page.incomeStatementBalanceNullFrom).toBe('2025-03-01');
      const labour = page.lines.filter(l => l.accountCode === '5200');
      expect(labour.filter(l => l.date < '2025-03-01').map(l => l.runningBalance)).toEqual([7]);
      expect(labour.filter(l => l.date >= '2025-03-01').map(l => l.runningBalance)).toEqual([null, null, null, null]);
      expect(page.lines.filter(l => l.accountCode === '1100').every(l => typeof l.runningBalance === 'number')).toBe(true);
      // Inside one fiscal year nothing is nulled.
      const inYear = await getGeneralLedgerLines({ companyId: company, periodStart: '2026-03-01', periodEnd: '2026-09-30', limit: 100 });
      expect(inYear.incomeStatementBalanceNullFrom).toBeNull();
      expect(inYear.lines.every(l => typeof l.runningBalance === 'number')).toBe(true);
    });
  }, 30000);

  it.skipIf(!reachable)('non-March FY (July) ties to the TB; another tenant’s FY is not used', async () => {
    await withLedger(7, async () => {
      expect(tbClosing(await getTrialBalance(company, SEPT), '5200')).toBe(50);
      expect(await ledger('5200', '2026-09-01')).toMatchObject({ openingBalance: 0, periodClosingBalance: 50 });
      expect((await ledger('5200', '2026-01-01')).rows.find(r => r.derived)?.entryDate).toBe('2026-06-30');
    }, 3);
  });

  it.skipIf(!reachable)('NULL financial_year_start falls back to March everywhere', async () => {
    await withLedger(null, async () => {
      const tb = tbClosing(await getTrialBalance(company, SEPT), '5200');
      expect(tb).toBe(250);
      expect((await ledger('5200', '2026-09-01')).periodClosingBalance).toBe(tb);
      expect((await getAccountTransactions(company, '5200', '2026-09-01', '2026-09-30')).closingBalance).toBe(tb);
    }, 7);
  });

  it.skipIf(!reachable)('last month of the FY (Feb) ties; balance-sheet account is cumulative', async () => {
    await withLedger(3, async () => {
      expect((await ledger('5200', '2026-02-01', '2026-02-28')).periodClosingBalance)
        .toBe(tbClosing(await getTrialBalance(company, FEB), '5200'));
      const bank = await ledger('1100', '2026-09-01');
      expect(bank.periodClosingBalance).toBe(tbClosing(await getTrialBalance(company, SEPT), '1100'));
      expect((await ledger('1100', '2025-01-01')).periodClosingBalance).toBe(bank.periodClosingBalance);
      expect((await ledger('1100', '2025-01-01')).rows.some(r => r.derived)).toBe(false);
    });
  });
});
