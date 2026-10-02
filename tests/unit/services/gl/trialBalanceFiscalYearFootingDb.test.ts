/**
 * D4: the trial balance floors income-statement accounts at the fiscal year
 * containing the period END, so a period that starts in one fiscal year and
 * ends in the next (a Jan–Dec period on a March company) agrees with the
 * ledger listings. This sweeps every month across two fiscal years, plus
 * quarter and twelve-month periods that are mostly misaligned, for FY start
 * months 1, 2, 3 and 12, and asserts for each:
 *
 *   - the TB foots at the opening, the movement and the closing;
 *   - every row (RE-BF included) opens and closes where the GL report does;
 *   - balance-sheet rows are their inception-to-date balance, independently summed;
 *   - income-statement rows are the movement since the fiscal year containing the period end.
 *
 * Temp tables in a rolled-back transaction (ledgerAgreementFixture) — no persistent writes.
 */
import { describe, expect, it, vi } from 'vitest';
import { getTrialBalanceReport } from '@/modules/accounting/services/gl/trialBalanceService';
import { getGeneralLedgerReport } from '@/modules/accounting/services/gl/generalLedgerReportService';
import { fiscalYearStart } from '@/modules/accounting/services/gl/fiscalYearBasis';
import type { TrialBalanceRow } from '@/modules/accounting/types/gl.types';
import { isDbReachable } from '../../helpers/dbReachable';
import {
  ACCOUNT_CODE, company, fixtureJournals, NORMAL, withLedger, type FixturePeriod,
} from '../reports/ledgerAgreementFixture';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

const TYPE: Record<string, string> = { '1100': 'asset', '3000': 'equity', '5200': 'expense', '4300': 'revenue' };

const ym = (y: number, m: number) => `${y}-${String(m).padStart(2, '0')}`;
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
/** Period of `months` months starting on the first of (y, m). */
function span(y: number, m: number, months: number): [string, string] {
  const endIndex = y * 12 + (m - 1) + months - 1;
  const ey = Math.floor(endIndex / 12);
  const em = (endIndex % 12) + 1;
  return [`${ym(y, m)}-01`, `${ym(ey, em)}-${String(lastDay(ey, em)).padStart(2, '0')}`];
}

/** Monthly 2024-06..2026-09 (two full fiscal years for any start month), quarters, twelve-month windows. */
const periods: FixturePeriod[] = [];
for (const [months, lastStart] of [[1, 2026 * 12 + 8], [3, 2026 * 12 + 6], [12, 2025 * 12 + 9]] as const) {
  for (let i = 2024 * 12 + 5; i <= lastStart; i++) {
    const [start, end] = span(Math.floor(i / 12), (i % 12) + 1, months);
    periods.push([`30000000-0000-4000-8000-${String(periods.length + 1).padStart(12, '0')}`, start, end]);
  }
}

const signed = (code: string, debit: number, credit: number) => (NORMAL[code] === 'debit' ? debit - credit : credit - debit);

/** Independent expectation for one posted account, straight from the fixture journals. */
function expectedClosing(code: string, end: string, fy: number): number {
  const floor = ['revenue', 'expense'].includes(TYPE[code]!) ? fiscalYearStart(end, fy) : '0000-00-00';
  return fixtureJournals
    .filter(([date]) => date >= floor && date <= end)
    .flatMap(([, lines]) => lines.filter(([id]) => ACCOUNT_CODE[id] === code))
    .reduce((s, [, d, c]) => s + signed(code, d, c), 0);
}

const sum = (rows: TrialBalanceRow[], key: keyof TrialBalanceRow) => rows.reduce((s, r) => s + Number(r[key] ?? 0), 0);

describe('trial balance — fiscal year of the period end, every month (Postgres)', async () => {
  const reachable = await isDbReachable();

  for (const fy of [1, 2, 3, 12]) {
    it.skipIf(!reachable)(`FY start month ${fy}: foots and agrees with the GL report for every period`, async () => {
      await withLedger(fy, async () => {
        let misaligned = 0;
        for (const [id, start, end] of periods) {
          const at = `fy ${fy} ${start}..${end}`;
          if (fiscalYearStart(start, fy) !== fiscalYearStart(end, fy)) misaligned += 1;
          const report = await getTrialBalanceReport(company, id);
          expect([report.periodStart, report.periodEnd, report.fiscalYearStart], at)
            .toEqual([start, end, fiscalYearStart(end, fy)]);
          expect([report.balanced, report.difference], at).toEqual([true, 0]);
          expect(Math.abs(sum(report.rows, 'openingDebit') - sum(report.rows, 'openingCredit')), `${at} opening`).toBeLessThan(0.005);
          expect(Math.abs(sum(report.rows, 'periodDebit') - sum(report.rows, 'periodCredit')), `${at} movement`).toBeLessThan(0.005);

          const gl = await getGeneralLedgerReport(company, start, end);
          const codes = new Set([...report.rows.map(r => r.accountCode), ...gl.map(a => a.accountCode)]);
          for (const code of codes) {
            const row = report.rows.find(r => r.accountCode === code);
            const ledger = gl.find(a => a.accountCode === code);
            const tb = row
              ? [signed(code, row.openingDebit ?? 0, row.openingCredit ?? 0), signed(code, row.debitBalance, row.creditBalance)]
              : [0, 0];
            expect(tb, `${at} ${code}`).toEqual([ledger?.openingBalance ?? 0, ledger?.closingBalance ?? 0]);
            if (code !== 'RE-BF') expect(tb[1], `${at} ${code} independent`).toBe(expectedClosing(code, end, fy));
          }
        }
        // Without misaligned periods this sweep would not exercise the fix at all.
        expect(misaligned).toBeGreaterThan(10);
      }, 3, periods);
    }, 60000);
  }
});
