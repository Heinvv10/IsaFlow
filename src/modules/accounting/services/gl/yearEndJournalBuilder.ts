/**
 * Building the year-end closing journal: which equity account it lands in, and
 * what the journal looks like line by line.
 *
 * Split from `yearEndCloseService` to stay inside the 300-line cap. The two
 * pieces here are the ones with judgement in them — everything else in the
 * close is orchestration.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type {
  CloseYearError,
  YearEndJournalLine,
  YearEndJournalPreview,
} from './yearEndCloseService';

export interface AccountBalanceRow {
  id: string;
  account_code: string;
  account_name: string;
  balance: string;
}

export interface RetainedEarningsAccount { id: string; accountCode: string; accountName: string }

export async function resolveRetainedEarnings(
  companyId: string,
): Promise<RetainedEarningsAccount | Extract<CloseYearError, { error: 'no_retained_earnings' | 'ambiguous_retained_earnings' }>> {
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
  // and a differently-coded "Retained Earnings (old)" would get either — the
  // same shape as the system-account collision migration 525 was written for.
  //
  // And where the code match does NOT single one out, the close REFUSES rather
  // than picking. Posting a year of trading into whichever equity account came
  // back first, then locking every period behind it, is not a mistake anyone
  // finds later: the journal balances and the statements look ordinary.
  const rows = await sql`
    SELECT id, account_code, account_name FROM gl_accounts
    WHERE company_id = ${companyId}
      AND (account_code = ${code} OR account_name ILIKE '%retained earnings%')
    ORDER BY (account_code = ${code}) DESC, account_code
    LIMIT 5
  `;
  const row = rows[0];
  if (!row) return { error: 'no_retained_earnings', accountCode: code };
  if (rows.length > 1 && String(row.account_code) !== code) {
    return {
      error: 'ambiguous_retained_earnings',
      accountCodes: rows.map((r) => String(r.account_code)),
    };
  }
  return {
    id: String(row.id),
    accountCode: String(row.account_code),
    accountName: String(row.account_name),
  };
}

export function buildPreview(
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

