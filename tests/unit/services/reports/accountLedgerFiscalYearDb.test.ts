/**
 * LED-01 (W2-04): the account-detail drill-down must tie to the trial balance
 * row it was opened from.
 *
 * Income-statement accounts restart at the fiscal-year start (trialBalanceBasis),
 * so their opening balance on the drill-down is the year-to-date movement
 * before `fromDate`, never everything since inception. Balance-sheet accounts
 * keep their cumulative opening.
 *
 * Real rows (company, period and its financial year, accounts, journals) in a
 * transaction that is always rolled back — no persistent writes.
 */
import { describe, expect, it, vi } from 'vitest';
import { als } from '@/lib/als';
import { getPoolForTests } from '@/lib/neon';
import { getAccountLedger } from '@/modules/accounting/services/reports/accountLedgerService';
import { getTrialBalance } from '@/modules/accounting/services/gl/trialBalanceService';
import type { TrialBalanceRow } from '@/modules/accounting/types/gl.types';
import { isDbReachable } from '../../helpers/dbReachable';
import { assertNotProductionDb } from '../../../helpers/assertNotProductionDb';
import { insertAccount, insertCompany, insertJournal, insertPeriod } from '../../helpers/realLedgerRows';

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
// Draft (unposted) lines on 5200 only: invisible to the TB and to postedOnly reads.
const drafts: Array<[string, number]> = [['2025-07-01', 5], ['2026-05-05', 11]];

async function withLedger(run: () => Promise<void>) {
  assertNotProductionDb('Rolled-back account-ledger fiscal-year regression');
  const client = await getPoolForTests().connect();
  try {
    await client.query('BEGIN');
    await als.run({ client, companyId: company, userId: '', claims: {} }, async () => {
      await insertCompany(company, 3);
      await insertPeriod(period, company, '2026-09-01', '2026-09-30');
      for (const [id, code, name, type, normal] of [
        [acct.bank, '1100', 'Bank', 'asset', 'debit'],
        [acct.equity, '3000', 'Capital', 'equity', 'credit'],
        [acct.labour, '5200', 'Labour Costs', 'expense', 'debit'],
        [acct.income, '4300', 'Other Income', 'revenue', 'credit'],
      ] as const) {
        await insertAccount(id, company, code, name, type, normal);
      }
      let n = 0;
      for (const [date, lines] of journals) {
        n += 1;
        await insertJournal({ id: `40000000-0000-4000-8000-${String(n).padStart(12, '0')}`, companyId: company,
          date, lines, entryNumber: String(n) });
      }
      for (const [date, debit] of drafts) {
        n += 1;
        await insertJournal({ id: `40000000-0000-4000-8000-${String(n).padStart(12, '0')}`, companyId: company,
          date, lines: [[acct.labour, debit, 0]], entryNumber: String(n), status: 'draft', description: 'Draft' });
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

  it.skipIf(!reachable)('postedOnly=false floors and closes the same way, counting drafts', async () => {
    await withLedger(async () => {
      const all = (from: string) => getAccountLedger({ companyId: company, accountCode: '5200', fromDate: from,
        toDate: '2026-09-30', postedOnly: false });
      // The 2025-07-01 draft belongs to the prior fiscal year: not in September's opening.
      expect(await all('2026-09-01')).toMatchObject({ openingBalance: 211, periodNet: 50, periodClosingBalance: 261 });
      const jan = await all('2026-01-01');
      expect(jan).toMatchObject({ openingBalance: 1005, periodNet: 561, closedToRetainedEarnings: -1305, periodClosingBalance: 261 });
      expect(jan.rows.find(r => r.derived)).toMatchObject({ entryDate: '2026-02-28', credit: 1305, runningBalance: 0 });
    });
  });

  it.skipIf(!reachable)('every page carries the same rows and running balances as the unpaged read', async () => {
    await withLedger(async () => {
      for (const [code, from] of [['5200', '2024-01-01'], ['5200', '2026-01-01'], ['1100', '2025-01-01']] as const) {
        const whole = await getAccountLedger({ companyId: company, accountCode: code, fromDate: from, toDate: '2026-09-30' });
        expect(whole.rows.length).toBe(whole.total);
        for (const limit of [1, 2, 3]) {
          const paged = [];
          for (let offset = 0; offset < whole.total; offset += limit) {
            const page = await getAccountLedger({ companyId: company, accountCode: code, fromDate: from,
              toDate: '2026-09-30', limit, offset });
            expect(page.total).toBe(whole.total);
            paged.push(...page.rows);
          }
          expect(paged).toEqual(whole.rows);
        }
      }
      // Non-vacuity: the 5200 cross-FY reads really do carry close rows.
      const crossed = await ledger('5200', '2024-01-01');
      expect(crossed.rows.filter(r => r.derived).map(r => [r.entryDate, r.credit])).toEqual([
        ['2025-02-28', 7], ['2026-02-28', 1300],
      ]);
    });
  });
});
