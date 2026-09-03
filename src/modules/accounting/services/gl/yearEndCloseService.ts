/**
 * Year-end close: roll the P&L into retained earnings and lock the year.
 *
 * Split out of `yearEndService` (which kept the read-side `listFiscalYears`)
 * when the close gained a dry run and outgrew the 300-line cap.
 *
 * ── WHY THE DRY RUN IS THE IMPORTANT HALF ───────────────────────────────────
 *
 * Brightsphere has four unclosed year-ends and R8.46m of retained earnings with
 * no journal lines behind it, so equity is a computed residual and the balance
 * sheet balancing proves nothing. Closing those years posts four journals that
 * move a decade of trading into equity and then LOCKS every period, which is
 * not a call anyone should make sight-unseen. `dryRun` runs every guard the
 * live call runs, reports the periods that block it BY NAME, and returns the
 * journal line by line. Only the write is skipped.
 *
 * ── TWO DEFECTS FIXED IN PASSING ────────────────────────────────────────────
 *
 * 1. The `retained_earnings_account` setting was read from `app_settings` with
 *    NO company_id predicate, on a view that has a `company_id` column. One
 *    tenant's setting would have chosen another tenant's equity account. There
 *    are zero rows in that view today, so it was latent — and it is exactly the
 *    kind of latent that becomes real the first time somebody configures it.
 *
 * 2. The account lookup was `LIMIT 1` with no `ORDER BY` over
 *    `account_code = X OR account_name ILIKE '%retained earnings%'`. With both
 *    a code match and a name match present, which one wins is physical row
 *    order — the same class of defect migration 525 was written for. The code
 *    match is now preferred explicitly.
 */

import { sql, withTransaction } from '@/lib/neon';
import type { AccountBalanceRow } from './yearEndJournalBuilder';
import { log } from '@/lib/logger';
import { fmtDate } from '@/lib/fmtDate';
import { getFiscalPeriodIdForDate } from './fiscalPeriodService';
import { getFiscalYearStartMonth } from './fiscalYearBasis';
import { buildPreview, resolveRetainedEarnings } from './yearEndJournalBuilder';
import { fiscalYearRange } from './fiscalYearCalendar';

export interface YearEndJournalLine {
  accountId: string;
  accountCode: string;
  accountName: string;
  debit: number;
  credit: number;
}

export interface YearEndJournalPreview {
  /** The year's last day — where the closing journal lands. */
  entryDate: string;
  entryNumber: string;
  description: string;
  lines: YearEndJournalLine[];
  totalDebit: number;
  totalCredit: number;
}

export interface CloseYearResult {
  closingEntry: Record<string, unknown>;
  netIncome: number;
  message: string;
}

export interface CloseYearDryRunResult {
  dryRun: true;
  netIncome: number;
  preview: YearEndJournalPreview;
}

export type CloseYearError =
  | { error: 'open_periods'; count: number; openPeriods: Array<{ id: string; periodName: string; periodNumber: number }> }
  | { error: 'year_not_found' }
  | { error: 'no_retained_earnings' }
  | { error: 'ambiguous_retained_earnings'; accountCodes: string[] }
  | { error: 'no_fiscal_period'; entryDate: string }
  | {
      error: 'period_range_mismatch';
      expected: { startDate: string; endDate: string };
      actual: { startDate: string; endDate: string };
      startMonth: number;
    };

export interface CloseYearOptions {
  /** Run every guard and return the journal, writing nothing. */
  dryRun?: boolean;
}

export async function closeFiscalYear(
  companyId: string,
  yearLabel: string,
  userId: string,
  options: CloseYearOptions = {},
): Promise<CloseYearResult | CloseYearDryRunResult | CloseYearError> {
  const dryRun = options.dryRun === true;

  // 1. Every period must be closed. Named, not counted: "3 periods are open" is
  //    not something a caller can act on.
  const openRows = (await sql`
    SELECT id, period_name, period_number FROM fiscal_periods
    WHERE fiscal_year = ${yearLabel} AND company_id = ${companyId} AND status = 'open'
    ORDER BY period_number
  `) as Record<string, unknown>[];
  if (openRows.length > 0) {
    return {
      error: 'open_periods',
      count: openRows.length,
      openPeriods: openRows.map((r) => ({
        id: String(r.id),
        periodName: String(r.period_name),
        periodNumber: Number(r.period_number),
      })),
    };
  }

  // 2. The year's date range.
  const rangeRows = await sql`
    SELECT MIN(start_date) AS start_date, MAX(end_date) AS end_date
    FROM fiscal_periods WHERE fiscal_year = ${yearLabel} AND company_id = ${companyId}
  `;
  const yearRange = rangeRows[0];
  if (!yearRange || yearRange.start_date === null) return { error: 'year_not_found' };

  // 2a. The periods must actually BE this company's fiscal year.
  //
  // Brightsphere's "fiscal year 2026" runs 1 Jan – 31 Dec 2026 while its
  // declared financial year starts in March, so the real FY2026 is
  // 1 Mar 2025 – 28 Feb 2026. Closing the calendar span rolls the WRONG twelve
  // months into retained earnings and then LOCKS every period behind it —
  // and nothing about the arithmetic looks wrong afterwards, because the
  // journal balances either way.
  //
  // No fallback on the start month. This is a write path; assuming March for a
  // company genuinely on a December year end produces a close a quarter out,
  // silently.
  const startMonth = await getFiscalYearStartMonth(companyId);
  const expected = fiscalYearRange(Number(yearLabel), startMonth);
  const actual = { startDate: fmtDate(yearRange.start_date), endDate: fmtDate(yearRange.end_date) };
  if (actual.startDate !== expected.startDate || actual.endDate !== expected.endDate) {
    return { error: 'period_range_mismatch', expected, actual, startMonth };
  }

  const revenueAccounts = (await sql`
    SELECT ga.id, ga.account_code, ga.account_name,
      COALESCE(SUM(CASE WHEN je.id IS NULL THEN 0 ELSE jl.credit - jl.debit END), 0)::numeric AS balance
    FROM gl_accounts ga
    LEFT JOIN gl_journal_lines jl ON jl.gl_account_id = ga.id AND jl.company_id = ${companyId}::UUID
    LEFT JOIN gl_journal_entries je ON je.id = jl.journal_entry_id AND je.company_id = ${companyId}
      AND je.status = 'posted'
      AND je.entry_date >= ${yearRange.start_date}
      AND je.entry_date <= ${yearRange.end_date}
    WHERE ga.account_type = 'revenue' AND ga.company_id = ${companyId}
    GROUP BY ga.id, ga.account_code, ga.account_name
    HAVING COALESCE(SUM(CASE WHEN je.id IS NULL THEN 0 ELSE jl.credit - jl.debit END), 0) != 0
    ORDER BY ga.account_code
  `) as unknown as AccountBalanceRow[];

  const expenseAccounts = (await sql`
    SELECT ga.id, ga.account_code, ga.account_name,
      COALESCE(SUM(CASE WHEN je.id IS NULL THEN 0 ELSE jl.debit - jl.credit END), 0)::numeric AS balance
    FROM gl_accounts ga
    LEFT JOIN gl_journal_lines jl ON jl.gl_account_id = ga.id AND jl.company_id = ${companyId}::UUID
    LEFT JOIN gl_journal_entries je ON je.id = jl.journal_entry_id AND je.company_id = ${companyId}
      AND je.status = 'posted'
      AND je.entry_date >= ${yearRange.start_date}
      AND je.entry_date <= ${yearRange.end_date}
    WHERE ga.account_type = 'expense' AND ga.company_id = ${companyId}
    GROUP BY ga.id, ga.account_code, ga.account_name
    HAVING COALESCE(SUM(CASE WHEN je.id IS NULL THEN 0 ELSE jl.debit - jl.credit END), 0) != 0
    ORDER BY ga.account_code
  `) as unknown as AccountBalanceRow[];

  const totalRevenue = revenueAccounts.reduce((s, a) => s + Number(a.balance), 0);
  const totalExpenses = expenseAccounts.reduce((s, a) => s + Number(a.balance), 0);
  const netIncome = totalRevenue - totalExpenses;

  const retained = await resolveRetainedEarnings(companyId);
  if ('error' in retained) return retained;

  const preview = buildPreview(
    yearLabel, fmtDate(yearRange.end_date), revenueAccounts, expenseAccounts, retained, netIncome,
  );

  if (dryRun) return { dryRun: true, netIncome, preview };

  // Resolved BEFORE the transaction opens. A journal with a NULL
  // fiscal_period_id is outside the trial balance, the VAT201 and the AFS
  // permanently, and this one is followed immediately by LOCKING every period
  // in the year — so an unstamped year-end journal could never be corrected in
  // place afterwards. The raw INSERT bypasses createJournalEntry, which is what
  // resolves the period everywhere else.
  const fiscalPeriodId = await getFiscalPeriodIdForDate(companyId, preview.entryDate);
  if (!fiscalPeriodId) return { error: 'no_fiscal_period', entryDate: preview.entryDate };

  const closingEntry = await postClosingJournal(
    companyId, userId, yearLabel, preview, fiscalPeriodId,
  );

  log.info('Year-end processed', {
    year: yearLabel, entryId: closingEntry.id, netIncome, module: 'accounting',
  });

  return {
    closingEntry,
    netIncome,
    message: `Year ${yearLabel} closed. Net income R${netIncome.toFixed(2)} transferred to Retained Earnings.`,
  };
}

async function postClosingJournal(
  companyId: string,
  userId: string,
  yearLabel: string,
  preview: YearEndJournalPreview,
  fiscalPeriodId: string | null,
): Promise<Record<string, unknown>> {
  // Atomic: a partial year-end close is unrecoverable — half the P&L zeroed and
  // the periods left open.
  return withTransaction(async (tx) => {
    // NO total_debit / total_credit. Those columns do not exist on
    // gl_journal_entries — not in isaflow_dev, not in production — so this
    // INSERT raised 42703 and EVERY live year-end close failed before writing a
    // line, over MCP and through the UI route alike. Brightsphere's four
    // unclosed years are that, not an oversight by whoever runs the close. The
    // totals live on the lines and every reader derives them (see
    // transactionLedgerService, sageMigrationCompareService); the preview still
    // reports them to the caller, which is where they were actually wanted.
    const closingRows = await tx`
      INSERT INTO gl_journal_entries (
        id, company_id, entry_number, entry_date, fiscal_period_id, description,
        source, status, created_by, created_at, posted_by, posted_at, posting_agent
      ) VALUES (
        gen_random_uuid(), ${companyId}, ${preview.entryNumber}, ${preview.entryDate},
        ${fiscalPeriodId}, ${preview.description}, 'year_end', 'posted',
        ${userId}, NOW(), ${userId}, NOW(), 'system:year-end-close'
      ) RETURNING *
    `;
    const entry = (closingRows as Record<string, unknown>[])[0];
    if (!entry) throw new Error('Failed to create closing journal entry');

    for (const line of preview.lines) {
      await tx`
        INSERT INTO gl_journal_lines (id, journal_entry_id, gl_account_id, debit, credit, description, created_at, company_id)
        VALUES (gen_random_uuid(), ${entry.id}, ${line.accountId}, ${line.debit}, ${line.credit},
                'Year-end close', NOW(), ${companyId}::UUID)
      `;
    }

    await tx`
      UPDATE fiscal_periods SET status = 'locked'
      WHERE fiscal_year = ${yearLabel} AND company_id = ${companyId}
    `;

    return entry;
  });
}
