/**
 * The LED-01 ledger-agreement fixture (PR #595's breaker repro plus a revenue
 * account and capital), shared by ledgerFiscalYearAgreementDb and
 * trialBalanceFiscalYearFootingDb.
 *
 * Connection-local temp tables in a rolled-back transaction — no persistent
 * writes; the temp tables shadow the real ones on this connection only.
 */
import { als } from '@/lib/als';
import { getPoolForTests, sql } from '@/lib/neon';
import type { TrialBalanceRow } from '@/modules/accounting/types/gl.types';
import { assertNotProductionDb } from '../../../helpers/assertNotProductionDb';

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
      for (const [id, start, end] of extraPeriods) {
        await sql`INSERT INTO fiscal_periods VALUES (${id}::uuid, ${company}::uuid, ${start}::date, ${end}::date)`;
      }
      for (const [id, code, name, type] of [
        [acct.bank, '1100', 'Bank', 'asset'], [acct.equity, '3000', 'Capital', 'equity'],
        [acct.labour, '5200', 'Labour Costs', 'expense'], [acct.income, '4300', 'Other Income', 'revenue'],
      ] as const) {
        await sql`INSERT INTO gl_accounts VALUES (${id}::uuid, ${company}::uuid, ${code}, ${name}, ${type},
          ${NORMAL[code]!}, NULL)`;
      }
      for (const [n, [date, lines]] of fixtureJournals.entries()) {
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

/** A TB row's closing balance on its own normal side. */
export function tbClosing(rows: TrialBalanceRow[], code: string): number {
  const row = rows.find(r => r.accountCode === code);
  if (!row) throw new Error(`TB has no row for ${code}`);
  return row.normalBalance === 'debit' ? row.debitBalance - row.creditBalance : row.creditBalance - row.debitBalance;
}
