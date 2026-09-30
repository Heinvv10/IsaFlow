/**
 * LED-01 (W2-04): the account-detail drill-down must tie to the trial balance
 * row it was opened from.
 *
 * Income-statement accounts restart at the fiscal-year start (trialBalanceBasis),
 * so their opening balance on the drill-down is the year-to-date movement
 * before `fromDate`, never everything since inception. Balance-sheet accounts
 * keep their cumulative opening.
 *
 * Connection-local temp tables in a rolled-back transaction — no persistent
 * writes. The temp `companies` / `fiscal_periods` shadow the real tables on
 * this connection only.
 */
import { describe, expect, it, vi } from 'vitest';
import { als } from '@/lib/als';
import { getPoolForTests, sql } from '@/lib/neon';
import { getAccountLedger } from '@/modules/accounting/services/reports/accountLedgerService';
import { getTrialBalance } from '@/modules/accounting/services/gl/trialBalanceService';
import type { TrialBalanceRow } from '@/modules/accounting/types/gl.types';
import { isDbReachable } from '../../helpers/dbReachable';
import { assertNotProductionDb } from '../../../helpers/assertNotProductionDb';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

const company = '10000000-0000-4000-8000-0000000000a1';
const period = '20000000-0000-4000-8000-0000000000a1';
const acct = {
  bank: '50000000-0000-4000-8000-0000000000a1',
  equity: '50000000-0000-4000-8000-0000000000a2',
  labour: '50000000-0000-4000-8000-0000000000a3',
  income: '50000000-0000-4000-8000-0000000000a4',
};

// FY starts 1 March. Current FY = 2026-03-01 .. 2027-02-28; TB period = Sept 2026.
const journals: Array<[string, Array<[string, number, number]>]> = [
  ['2024-10-01', [[acct.labour, 7, 0], [acct.bank, 0, 7]]],         // two FYs back
  ['2025-05-01', [[acct.bank, 5000, 0], [acct.equity, 0, 5000]]],   // prior FY, balance sheet
  ['2025-06-10', [[acct.labour, 1000, 0], [acct.bank, 0, 1000]]],   // prior FY expense
  ['2025-12-01', [[acct.bank, 100, 0], [acct.income, 0, 100]]],     // prior FY revenue
  ['2026-02-20', [[acct.labour, 300, 0], [acct.bank, 0, 300]]],     // last day-ish of prior FY
  ['2026-04-15', [[acct.labour, 200, 0], [acct.bank, 0, 200]]],     // current FY, before period
  ['2026-05-01', [[acct.bank, 40, 0], [acct.income, 0, 40]]],       // current FY revenue
  ['2026-09-10', [[acct.labour, 50, 0], [acct.bank, 0, 50]]],       // in period
];

async function withLedger(run: () => Promise<void>) {
  assertNotProductionDb('Temporary-table account-ledger fiscal-year regression');
  const client = await getPoolForTests().connect();
  try {
    await client.query('BEGIN');
    await als.run({ client, companyId: company, userId: '', claims: {} }, async () => {
      await sql`CREATE TEMP TABLE IF NOT EXISTS companies (id uuid, financial_year_start int) ON COMMIT DROP`;
      await sql`CREATE TEMP TABLE IF NOT EXISTS fiscal_periods (id uuid, company_id uuid, start_date date,
        end_date date) ON COMMIT DROP`;
      await sql`CREATE TEMP TABLE IF NOT EXISTS gl_accounts (id uuid, company_id uuid, account_code text,
        account_name text, account_type text, normal_balance text) ON COMMIT DROP`;
      await sql`CREATE TEMP TABLE IF NOT EXISTS gl_journal_entries (id uuid, company_id uuid, status text, entry_date date,
        entry_number text, description text, reference text, source text) ON COMMIT DROP`;
      await sql`CREATE TEMP TABLE IF NOT EXISTS gl_journal_lines (company_id uuid, journal_entry_id uuid, gl_account_id uuid,
        debit numeric, credit numeric, cost_center_id uuid, cc1_id uuid, cc2_id uuid, bu_id uuid) ON COMMIT DROP`;
      await sql`INSERT INTO companies VALUES (${company}::uuid, 3)`;
      await sql`INSERT INTO fiscal_periods VALUES (${period}::uuid, ${company}::uuid, '2026-09-01', '2026-09-30')`;
      for (const [id, code, name, type, normal] of [
        [acct.bank, '1100', 'Bank', 'asset', 'debit'],
        [acct.equity, '3000', 'Capital', 'equity', 'credit'],
        [acct.labour, '5200', 'Labour Costs', 'expense', 'debit'],
        [acct.income, '4300', 'Other Income', 'revenue', 'credit'],
      ] as const) {
        await sql`INSERT INTO gl_accounts VALUES (${id}::uuid, ${company}::uuid, ${code}, ${name}, ${type}, ${normal})`;
      }
      let n = 0;
      for (const [date, lines] of journals) {
        n += 1;
        const je = `40000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
        await sql`INSERT INTO gl_journal_entries VALUES (${je}::uuid, ${company}::uuid, 'posted', ${date}::date,
          ${String(n)}, 'Fixture', '', 'manual')`;
        for (const [account, debit, credit] of lines) {
          await sql`INSERT INTO gl_journal_lines VALUES (${company}::uuid, ${je}::uuid, ${account}::uuid,
            ${debit}, ${credit}, NULL, NULL, NULL, NULL)`;
        }
      }
      await run();
    });
  } finally {
    try { await client.query('ROLLBACK'); } finally { client.release(); }
  }
}

/** The TB row's closing balance on the account's normal side. */
function tbClosing(rows: TrialBalanceRow[], code: string): number {
  const row = rows.find(r => r.accountCode === code);
  if (!row) throw new Error(`TB has no row for ${code}`);
  return row.normalBalance === 'debit' ? row.debitBalance - row.creditBalance : row.creditBalance - row.debitBalance;
}

const ledger = (accountCode: string, fromDate: string, toDate = '2026-09-30') =>
  getAccountLedger({ companyId: company, accountCode, fromDate, toDate });

describe('account ledger — fiscal-year basis (Postgres)', async () => {
  const reachable = await isDbReachable();

  it.skipIf(!reachable)('P&L account drilled from the TB period ties to the TB figure', async () => {
    await withLedger(async () => {
      const tb = await getTrialBalance(company, period);
      expect(tbClosing(tb, '5200')).toBe(250);
      expect(tbClosing(tb, '4300')).toBe(40);

      const labour = await ledger('5200', '2026-09-01');
      expect(labour).toMatchObject({ openingBalance: 200, periodNet: 50, periodClosingBalance: 250 });
      expect(labour.periodClosingBalance).toBe(tbClosing(tb, '5200'));

      const income = await ledger('4300', '2026-09-01');
      expect(income).toMatchObject({ openingBalance: 40, periodNet: 0, periodClosingBalance: 40 });
      expect(income.periodClosingBalance).toBe(tbClosing(tb, '4300'));
    });
  });

  it.skipIf(!reachable)('P&L account opening is zero at the fiscal-year start', async () => {
    await withLedger(async () => {
      const labour = await ledger('5200', '2026-03-01');
      expect(labour).toMatchObject({ openingBalance: 0, periodNet: 250, periodClosingBalance: 250 });
      expect(labour.rows.map(r => r.runningBalance)).toEqual([200, 250]);
      const income = await ledger('4300', '2026-03-01');
      expect(income).toMatchObject({ openingBalance: 0, periodClosingBalance: 40 });
    });
  });

  it.skipIf(!reachable)('P&L opening floors at the fiscal year of fromDate, not of today', async () => {
    await withLedger(async () => {
      // Prior FY 2025-03-01..2026-02-28: only the 2025-06-10 posting counts; the 2024 one is a FY earlier.
      const labour = await ledger('5200', '2026-01-01', '2026-02-28');
      expect(labour).toMatchObject({ openingBalance: 1000, periodNet: 300, periodClosingBalance: 1300 });
    });
  });

  it.skipIf(!reachable)('balance-sheet account still carries its prior-year opening and ties to the TB', async () => {
    await withLedger(async () => {
      const tb = await getTrialBalance(company, period);
      const bank = await ledger('1100', '2026-09-01');
      expect(bank).toMatchObject({ openingBalance: 3633, periodNet: -50, periodClosingBalance: 3583 });
      expect(bank.periodClosingBalance).toBe(tbClosing(tb, '1100'));

      const atFyStart = await ledger('1100', '2026-03-01');
      expect(atFyStart.openingBalance).toBe(3793); // -7 + 5000 - 1000 + 100 - 300, all prior years
    });
  });
});
