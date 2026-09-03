/**
 * Building the year-end closing journal: which equity account it lands in, and
 * what the journal looks like line by line.
 *
 * Split from `yearEndCloseService` to stay inside the 300-line cap. The two
 * pieces here are the ones with judgement in them — everything else in the
 * close is orchestration.
 */

import { log } from '@/lib/logger';
import { getSystemAccountCandidates } from './systemAccountResolver';
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
  // The system-account RESOLVER, and its CANDIDATES rather than its winner.
  //
  // This used to read a code out of `app_settings` — unscoped by company, on a
  // view that HAS a company_id column — and then `LIMIT 1` over
  // `account_code = X OR account_name ILIKE '%retained earnings%'` with no
  // ORDER BY. A heap-order winner over a name match: the shape migration 525
  // exists for.
  //
  // `getSystemAccount` would break a tie deterministically and only log it.
  // That is right for callers that must keep working and wrong here, where one
  // entry moves a whole year's profit into equity and then locks every period
  // behind it. So the close asks for every CANDIDATE and refuses on more than
  // one. Both refusals happen before the write transaction opens.
  const candidates = await getSystemAccountCandidates('retained_earnings', companyId);

  if (candidates.length === 0) {
    log.error('Year-end close refused: no retained earnings system account',
      { companyId }, 'yearEnd');
    return { error: 'no_retained_earnings' };
  }
  if (candidates.length > 1) {
    const accountCodes = candidates.map((a) => a.accountCode);
    log.error('Year-end close refused: retained earnings role is contested',
      { companyId, accountCodes }, 'yearEnd');
    return { error: 'ambiguous_retained_earnings', accountCodes };
  }

  const account = candidates[0]!;
  return { id: account.id, accountCode: account.accountCode, accountName: account.accountName };
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

