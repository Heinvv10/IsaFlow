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
  // The SIDE COMES FROM THE SIGN, not from the account type.
  //
  // `balance` is a NET measure — revenue is `credit - debit`, expense is
  // `debit - credit` — and the `HAVING ... != 0` filters keep contra rows in.
  // A revenue account carrying a net DEBIT balance (a refund or reversal
  // larger than the year's billing to it) therefore arrives NEGATIVE, and
  // writing it straight into `debit` produced `debit: -500`, which
  // `gl_journal_lines_debit_check` rejects with 23514. The whole close then
  // aborted, so a tenant with one contra P&L account could never close a year.
  // Closing such an account still means posting the opposite of its balance;
  // only the side flips. `netIncome` is unchanged and the journal still
  // balances either way.
  const lines: YearEndJournalLine[] = [
    ...revenueAccounts.map((a) => {
      const balance = Number(a.balance);
      return {
        accountId: String(a.id), accountCode: String(a.account_code), accountName: String(a.account_name),
        debit: balance >= 0 ? balance : 0, credit: balance < 0 ? -balance : 0,
      };
    }),
    ...expenseAccounts.map((a) => {
      const balance = Number(a.balance);
      return {
        accountId: String(a.id), accountCode: String(a.account_code), accountName: String(a.account_name),
        debit: balance < 0 ? -balance : 0, credit: balance >= 0 ? balance : 0,
      };
    }),
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

