/**
 * The LED-01 ledger-agreement fixture (PR #595's breaker repro plus a revenue
 * account and capital), shared by ledgerFiscalYearAgreementDb,
 * trialBalanceFiscalYearFootingDb and the MCP trial_balance suite.
 *
 * REAL rows (companies, fiscal periods and the financial years they link to,
 * accounts, journals, lines) in one transaction that is always ROLLED BACK, so
 * nothing persists. Temp tables named like real ones are not an option: the
 * fiscal-year registry's SQL functions pin `search_path = ..., public, pg_temp`
 * and read the public tables (tests/unit/helpers/realLedgerRows.ts).
 *
 * SEPT and FEB are real periods. `extraPeriods` are REPORT WINDOWS (a Jan-Dec
 * year on a March company, 3- and 24-month spans, a month beside SEPT): real
 * fiscal periods cannot be those any more (migration 940: a period lies inside
 * one financial year of at most 15 months and a company's periods never
 * overlap), but the trial balance still accepts any period row, so the report
 * must stay correct for one. Only when windows are asked for, a TEMP
 * `fiscal_periods` (SEPT, FEB and the windows) shadows the real table for
 * this connection's application SQL; the registry reads fiscal_years, which
 * the real SEPT/FEB periods created, never fiscal_periods.
 */
import { als } from '@/lib/als';
import { getPoolForTests, sql } from '@/lib/neon';
import type { TrialBalanceRow } from '@/modules/accounting/types/gl.types';
import { assertNotProductionDb } from '../../../helpers/assertNotProductionDb';
import { insertAccount, insertCompany, insertJournal, insertPeriod } from '../../helpers/realLedgerRows';

export const company = '10000000-0000-4000-8000-0000000000b1';
const other = '10000000-0000-4000-8000-0000000000b2';
export const SEPT = '20000000-0000-4000-8000-0000000000b1';
export const FEB = '20000000-0000-4000-8000-0000000000b2';
export const acct = {
  bank: '50000000-0000-4000-8000-0000000000b1',
  equity: '50000000-0000-4000-8000-0000000000b2',
  labour: '50000000-0000-4000-8000-0000000000b3',
  income: '50000000-0000-4000-8000-0000000000b4',
};
/** Account id → code, for reading `fixtureJournals` by code. */
export const ACCOUNT_CODE: Record<string, string> = {
  [acct.bank]: '1100', [acct.equity]: '3000', [acct.labour]: '5200', [acct.income]: '4300',
};
export const NORMAL: Record<string, 'debit' | 'credit'> = { '1100': 'debit', '3000': 'credit', '5200': 'debit', '4300': 'credit', 'RE-BF': 'credit' };

// The breaker's fixture (5200) plus a revenue account (4300, the audit's GL-report case) and capital.
export const fixtureJournals: Array<[string, Array<[string, number, number]>]> = [
  ['2024-06-01', [[acct.bank, 5000, 0], [acct.equity, 0, 5000]]],
  ['2024-10-01', [[acct.labour, 7, 0], [acct.bank, 0, 7]]],
  ['2025-06-10', [[acct.labour, 1000, 0], [acct.bank, 0, 1000]]],
  ['2025-12-01', [[acct.bank, 100, 0], [acct.income, 0, 100]]],
  ['2026-02-20', [[acct.labour, 300, 0], [acct.bank, 0, 300]]],
  ['2026-04-15', [[acct.labour, 200, 0], [acct.bank, 0, 200]]],
  ['2026-05-01', [[acct.bank, 40, 0], [acct.income, 0, 40]]],
  ['2026-09-10', [[acct.labour, 50, 0], [acct.bank, 0, 50]]],
];

/** [id, start, end] — extra fiscal periods for `company`, beside SEPT and FEB 2026. */
export type FixturePeriod = [string, string, string];

export async function withLedger(
  fy: number | null,
  run: () => Promise<void>,
  otherFy: number | null = 3,
  extraPeriods: FixturePeriod[] = [],
) {
  assertNotProductionDb('LED-01 ledger agreement');
  const client = await getPoolForTests().connect();
  try {
    await client.query('BEGIN');
    await als.run({ client, companyId: company, userId: '', claims: {} }, async () => {
      await insertCompany(company, fy);
      await insertCompany(other, otherFy, 'Fixture other tenant');
      await insertPeriod(SEPT, company, '2026-09-01', '2026-09-30');
      await insertPeriod(FEB, company, '2026-02-01', '2026-02-28');
      if (extraPeriods.length > 0) {
        await sql`CREATE TEMP TABLE fiscal_periods ON COMMIT DROP AS
          SELECT * FROM public.fiscal_periods WHERE company_id = ${company}::uuid`;
        for (const [id, start, end] of extraPeriods) {
          await sql`INSERT INTO fiscal_periods (id, company_id, period_name, period_number, fiscal_year,
              start_date, end_date, status)
            VALUES (${id}::uuid, ${company}::uuid, ${`W ${start}`}, 0, 0, ${start}::date, ${end}::date, 'open')`;
        }
      }
      for (const [id, code, name, type] of [
        [acct.bank, '1100', 'Bank', 'asset'], [acct.equity, '3000', 'Capital', 'equity'],
        [acct.labour, '5200', 'Labour Costs', 'expense'], [acct.income, '4300', 'Other Income', 'revenue'],
      ] as const) {
        await insertAccount(id, company, code, name, type, NORMAL[code]!);
      }
      for (const [n, [date, lines]] of fixtureJournals.entries()) {
        await insertJournal({
          id: `40000000-0000-4000-8000-${String(n + 1).padStart(12, '0')}`, companyId: company, date, lines,
          entryNumber: String(n + 1), createdAt: date,
        });
      }
      await run();
    });
  } finally {
    try { await client.query('ROLLBACK'); } finally { client.release(); }
  }
}

/** A TB row's closing balance on its own normal side. */
export function tbClosing(rows: TrialBalanceRow[], code: string): number {
  const row = rows.find(r => r.accountCode === code);
  if (!row) throw new Error(`TB has no row for ${code}`);
  return row.normalBalance === 'debit' ? row.debitBalance - row.creditBalance : row.creditBalance - row.debitBalance;
}
