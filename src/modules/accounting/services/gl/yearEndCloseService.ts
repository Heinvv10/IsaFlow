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
import { log } from '@/lib/logger';
import { fmtDate } from '@/lib/fmtDate';

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
  | { error: 'no_retained_earnings'; accountCode: string }
  | { error: 'ambiguous_retained_earnings'; accountCodes: string[] };

export interface CloseYearOptions {
  /** Run every guard and return the journal, writing nothing. */
  dryRun?: boolean;
}

interface AccountBalanceRow {
  id: string;
  account_code: string;
  account_name: string;
  balance: string;
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

  const closingEntry = await postClosingJournal(companyId, userId, yearLabel, preview);

  log.info('Year-end processed', {
    year: yearLabel, entryId: closingEntry.id, netIncome, module: 'accounting',
  });

  return {
    closingEntry,
    netIncome,
    message: `Year ${yearLabel} closed. Net income R${netIncome.toFixed(2)} transferred to Retained Earnings.`,
  };
}

interface RetainedEarningsAccount { id: string; accountCode: string; accountName: string }

async function resolveRetainedEarnings(
  companyId: string,
): Promise<RetainedEarningsAccount | { error: 'no_retained_earnings'; accountCode: string }> {
  let code = '3200';
  try {
    // company_id, on a view that has one. Without it a single configured row
    // anywhere in the platform decides every tenant's equity account.
    const settingRows = await sql`
      SELECT value FROM app_settings
       WHERE key = 'retained_earnings_account' AND company_id = ${companyId}::UUID
       LIMIT 1
    `;
    if (settingRows[0]?.value) code = String(settingRows[0].value);
  } catch (err) {
    log.warn('Could not load retained_earnings_account setting, using default 3200', { error: String(err) }, 'yearEnd');
  }

  // The code match is preferred EXPLICITLY. `LIMIT 1` over an OR with no
  // ORDER BY is decided by physical row order, and a company with both a 3200
  // and a differently-coded "Retained Earnings (old)" would get either.
  const rows = await sql`
    SELECT id, account_code, account_name FROM gl_accounts
    WHERE company_id = ${companyId}
      AND (account_code = ${code} OR account_name ILIKE '%retained earnings%')
    ORDER BY (account_code = ${code}) DESC, account_code
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return { error: 'no_retained_earnings', accountCode: code };
  return {
    id: String(row.id),
    accountCode: String(row.account_code),
    accountName: String(row.account_name),
  };
}

function buildPreview(
  yearLabel: string,
  entryDate: string,
  revenueAccounts: AccountBalanceRow[],
  expenseAccounts: AccountBalanceRow[],
  retained: RetainedEarningsAccount,
  netIncome: number,
): YearEndJournalPreview {
  const lines: YearEndJournalLine[] = [
    ...revenueAccounts.map((a) => ({
      accountId: String(a.id), accountCode: String(a.account_code), accountName: String(a.account_name),
      debit: Number(a.balance), credit: 0,
    })),
    ...expenseAccounts.map((a) => ({
      accountId: String(a.id), accountCode: String(a.account_code), accountName: String(a.account_name),
      debit: 0, credit: Number(a.balance),
    })),
    {
      accountId: retained.id, accountCode: retained.accountCode, accountName: retained.accountName,
      debit: netIncome < 0 ? Math.abs(netIncome) : 0,
      credit: netIncome >= 0 ? netIncome : 0,
    },
  ];

  return {
    entryDate,
    entryNumber: `YE-${yearLabel}`,
    description: `Year-End Closing: ${yearLabel}`,
    lines,
    totalDebit: lines.reduce((s, l) => s + l.debit, 0),
    totalCredit: lines.reduce((s, l) => s + l.credit, 0),
  };
}

async function postClosingJournal(
  companyId: string,
  userId: string,
  yearLabel: string,
  preview: YearEndJournalPreview,
): Promise<Record<string, unknown>> {
  // Atomic: a partial year-end close is unrecoverable — half the P&L zeroed and
  // the periods left open.
  return withTransaction(async (tx) => {
    const closingRows = await tx`
      INSERT INTO gl_journal_entries (
        id, company_id, entry_number, entry_date, description,
        source, status, total_debit, total_credit, created_by, created_at, posting_agent
      ) VALUES (
        gen_random_uuid(), ${companyId}, ${preview.entryNumber}, ${preview.entryDate},
        ${preview.description}, 'year_end', 'posted',
        ${preview.totalDebit}, ${preview.totalCredit}, ${userId}, NOW(), 'system:year-end-close'
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
