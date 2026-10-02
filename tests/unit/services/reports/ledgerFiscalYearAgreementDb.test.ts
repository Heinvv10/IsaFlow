/**
 * LED-01 (W2-04) round 1: every ledger listing of an account agrees with the
 * trial balance as at the same date — the TB, the account-detail page
 * (getAccountLedger), the inline drill-down panel (getAccountTransactions), the
 * GL report (getGeneralLedgerReport) and the MCP general_ledger stream.
 *
 * Adopts the adversarial breaker's repro cases for PR #595 (brk595Repro).
 * Fixture and harness: ledgerAgreementFixture.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import { sql } from '@/lib/neon';
import { getAccountLedger } from '@/modules/accounting/services/reports/accountLedgerService';
import { getAccountTransactions } from '@/modules/accounting/services/gl/transactionLedgerService';
import { getGeneralLedgerReport } from '@/modules/accounting/services/gl/generalLedgerReportService';
import { getGeneralLedgerLines } from '@/modules/accounting/services/gl/generalLedgerStreamService';
import { getIncomeStatement } from '@/modules/accounting/services/reports/incomeStatementService';
import { getTrialBalance, getTrialBalanceReport } from '@/modules/accounting/services/gl/trialBalanceService';
import { isDbReachable } from '../../helpers/dbReachable';
import { company, FEB, NORMAL, SEPT, tbClosing, withLedger } from './ledgerAgreementFixture';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

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

  // D4 (R1 on PR #595): a Jan–Dec period on a March-FY company starts in one fiscal year and ends in the
  // next. The TB floors income-statement accounts at the fiscal year containing the period END, as every
  // ledger view does: 5200 is 250 (Mar–Dec 2026), not 1550 (from 1 Mar 2025).
  it.skipIf(!reachable)('D4: a period crossing an FY start — TB opening, movement, derived close and closing agree with every listing', async () => {
    const YEAR = '20000000-0000-4000-8000-0000000000b3';
    await withLedger(3, async () => {
      const tbReport = await getTrialBalanceReport(company, YEAR);
      const tb = tbReport.rows;
      expect(tbReport.fiscalYearEndsClosed).toEqual(['2026-02-28']);
      expect(tbClosing(tb, '5200')).toBe(250);
      expect(tbClosing(tb, '4300')).toBe(40);
      // Profit before 1 Mar 2026: 100 income − 1307 labour.
      expect(tbClosing(tb, 'RE-BF')).toBe(-1207);
      // 5200 closes 1300 (Mar 2025–Feb 2026) and 4300 100; RE-BF takes the 1200 net loss.
      expect(['5200', '4300', 'RE-BF', '1100'].map(c => tb.find(r => r.accountCode === c)?.closedToRetainedEarnings))
        .toEqual([-1300, -100, -1200, 0]);
      const report = await getGeneralLedgerReport(company, '2026-01-01', '2026-12-31');
      const signed = (r: (typeof tb)[number], side: 'opening' | 'closing') => {
        const [dr, cr] = side === 'opening' ? [r.openingDebit ?? 0, r.openingCredit ?? 0] : [r.debitBalance, r.creditBalance];
        return r.normalBalance === 'debit' ? dr - cr : cr - dr;
      };
      for (const row of tb) {
        const gl = report.find(a => a.accountCode === row.accountCode);
        expect([signed(row, 'opening'), signed(row, 'closing')], row.accountCode)
          .toEqual([gl?.openingBalance, gl?.closingBalance]);
        // The GL report's derived close rows, on the account's normal side.
        const glClosed = (gl?.transactions ?? []).filter(t => t.derived)
          .reduce((s, t) => s + (row.normalBalance === 'debit' ? t.debit - t.credit : t.credit - t.debit), 0);
        expect(row.closedToRetainedEarnings, row.accountCode).toBe(glClosed);
        if (row.accountCode === 'RE-BF') continue;
        const detail = await ledger(row.accountCode, '2026-01-01', '2026-12-31');
        const inline = await getAccountTransactions(company, row.accountCode, '2026-01-01', '2026-12-31');
        const movement = row.normalBalance === 'debit'
          ? (row.periodDebit ?? 0) - (row.periodCredit ?? 0) : (row.periodCredit ?? 0) - (row.periodDebit ?? 0);
        expect([signed(row, 'opening'), movement, row.closedToRetainedEarnings, signed(row, 'closing')], row.accountCode)
          .toEqual([detail.openingBalance, detail.periodNet, detail.closedToRetainedEarnings, detail.periodClosingBalance]);
        expect([inline.openingBalance, inline.periodNet, inline.closingBalance], row.accountCode)
          .toEqual([detail.openingBalance, detail.periodNet, detail.periodClosingBalance]);
      }
    }, 3, [[YEAR, '2026-01-01', '2026-12-31']]);
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

  it.skipIf(!reachable)('year-0001 dates are refused before SQL, leaving the transaction usable (security round 3)', async () => {
    await withLedger(3, async () => {
      const probes: Array<[string, () => Promise<unknown>]> = [
        ['stream', () => getGeneralLedgerLines({ companyId: company, periodStart: '0001-01-01', periodEnd: '2026-09-30', limit: 10 })],
        ['ledger', () => ledger('5200', '0001-01-01')],
        ['report', () => getGeneralLedgerReport(company, '0001-01-01', '2026-09-30')],
        ['transactions', () => getAccountTransactions(company, '5200', '0001-01-01', '2026-09-30')],
      ];
      for (const [name, run] of probes) {
        // The bare Postgres cast error (22008, no year 0) is what this used to be.
        await expect(run(), name).rejects.toThrow(/invalid ledger date/);
        // A poisoned transaction would fail this with 25P02.
        expect(await sql`SELECT 1 AS ok`, name).toEqual([{ ok: 1 }]);
      }
    });
  }, 30000);

  // 1900-01-01 is the earliest legal date. Under any FY start month after January the FY floor is
  // 1899-<month>-01: a valid Postgres date, so the legal edge must work (nothing is lost, as no
  // posting predates 1900), and must not be refused or throw.
  it.skipIf(!reachable)('the legal edge 1900-01-01 floors into 1899 for every FY start month without error', async () => {
    for (const fy of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
      await withLedger(fy, async () => {
        const l = await ledger('5200', '1900-01-01', '1900-12-31');
        expect(l.openingBalance, `fy ${fy}`).toBe(0);
        expect(l.rows).toEqual([]);
        const page = await getGeneralLedgerLines({ companyId: company, periodStart: '1900-01-01', periodEnd: '1900-12-31', limit: 10 });
        expect(page.lines, `fy ${fy}`).toEqual([]);
        expect((await getGeneralLedgerReport(company, '1900-01-01', '1900-12-31')).length, `fy ${fy}`).toBe(0);
        expect((await getAccountTransactions(company, '5200', '1900-01-01', '1900-12-31')).openingBalance).toBe(0);
        // And a range from the edge up to the present still ties to the TB.
        expect((await ledger('5200', '1900-01-01')).periodClosingBalance).toBe(
          (await ledger('5200', '2026-09-01')).periodClosingBalance);
      });
    }
  }, 60000);

  it.skipIf(!reachable)('REVENUE across a fiscal-year start: closes to the TB figure, derived close on the DEBIT side, in every listing', async () => {
    await withLedger(3, async () => {
      // 4300 is credit-normal: 100 on 2025-12-01 (FY ended 2026-02-28), 40 on 2026-05-01.
      const tb = tbClosing(await getTrialBalance(company, SEPT), '4300');
      expect(tb).toBe(40);
      const l = await ledger('4300', '2025-06-01');
      const close = l.rows.find(r => r.derived)!;
      expect(close).toMatchObject({ entryDate: '2026-02-28', debit: 100, credit: 0, runningBalance: 0, source: 'year_end_close' });
      expect(l.periodClosingBalance).toBe(tb);
      expect(l.closedToRetainedEarnings).toBe(-100);
      const inline = await getAccountTransactions(company, '4300', '2025-06-01', '2026-09-30');
      expect(inline.transactions.find(t => t.derived)).toMatchObject({ debit: 100, credit: 0, balance: 0 });
      expect(inline.closingBalance).toBe(tb);
      const rep = (await glReport('4300', '2025-06-01'))!;
      expect(rep.transactions.find(t => t.derived)).toMatchObject({ debit: 100, credit: 0, balance: 0 });
      expect(rep.closingBalance).toBe(tb);
      // RE-BF receives the NET mirror image per year end: 5200 closes 1300 (credit) and 4300 100 (debit),
      // so the income-statement net is a 1200 credit and RE-BF takes the 1200 DEBIT (a loss).
      const re = (await glReport('RE-BF', '2025-06-01'))!;
      expect(re.transactions.map(t => [t.debit, t.credit].join('/'))).toEqual(['1200/0']);
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
