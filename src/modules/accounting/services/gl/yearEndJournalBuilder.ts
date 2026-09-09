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
import { roundToCents } from '../../utils/doubleEntry';
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

/**
 * The year's P&L movement, per account, that the closing journal transfers.
 *
 * Both sides are the SAME aggregate the trial balance uses — `je.status =
 * 'posted'` and `entry_date` inside the year — so the journal built from them
 * agrees with the trial balance it closes. Every clause is company_id-scoped,
 * on the account, on the line and on the header, because a LEFT JOIN unscoped
 * on one of the three would let another tenant's movement into this tenant's
 * equity.
 */
export async function loadPLBalances(
  companyId: string,
  startDate: unknown,
  endDate: unknown,
): Promise<{ revenueAccounts: AccountBalanceRow[]; expenseAccounts: AccountBalanceRow[] }> {
  const revenueAccounts = (await sql`
    SELECT ga.id, ga.account_code, ga.account_name,
      COALESCE(SUM(CASE WHEN je.id IS NULL THEN 0 ELSE jl.credit - jl.debit END), 0)::numeric AS balance
    FROM gl_accounts ga
    LEFT JOIN gl_journal_lines jl ON jl.gl_account_id = ga.id AND jl.company_id = ${companyId}::UUID
    LEFT JOIN gl_journal_entries je ON je.id = jl.journal_entry_id AND je.company_id = ${companyId}
      AND je.status = 'posted'
      AND je.entry_date >= ${startDate}
      AND je.entry_date <= ${endDate}
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
      AND je.entry_date >= ${startDate}
      AND je.entry_date <= ${endDate}
    WHERE ga.account_type = 'expense' AND ga.company_id = ${companyId}
    GROUP BY ga.id, ga.account_code, ga.account_name
    HAVING COALESCE(SUM(CASE WHEN je.id IS NULL THEN 0 ELSE jl.debit - jl.credit END), 0) != 0
    ORDER BY ga.account_code
  `) as unknown as AccountBalanceRow[];

  return { revenueAccounts, expenseAccounts };
}

/**
 * The year's net P&L movement, re-read.
 *
 * For the residual on an already-closed year, which cannot be inferred from the
 * netIncome the close computed on the way in: that read may predate the closing
 * journal (a concurrent close, or a re-run that raced one), and reporting it as
 * money left outside equity would raise the alarm on a year that is correctly
 * closed. Re-reading after the journal is known to exist answers the question
 * actually being asked — what is in this year that its closing journal is not?
 * The closing journal is itself inside the year and posted, so it nets out.
 */
export async function reloadNetIncome(
  companyId: string,
  startDate: unknown,
  endDate: unknown,
): Promise<number> {
  const { revenueAccounts, expenseAccounts } = await loadPLBalances(companyId, startDate, endDate);
  return revenueAccounts.reduce((s, a) => s + Number(a.balance), 0)
    - expenseAccounts.reduce((s, a) => s + Number(a.balance), 0);
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
  ];

  // A BREAK-EVEN YEAR HAS NOTHING TO TRANSFER, and appending a 0/0 line to say
  // so makes the journal illegal: `validateJournalEntry` requires a non-zero
  // amount on exactly one side of every line, so the close refused a journal
  // that was perfectly balanced. A dormant year is the same case with no P&L
  // lines either, and leaves `lines` EMPTY — the caller posts no journal at all
  // and just locks the year. The P&L lines already balance each other whenever
  // the result is zero, so dropping this line cannot unbalance anything.
  const transfer = roundToCents(netIncome);
  if (transfer !== 0) {
    lines.push({
      accountId: retained.id, accountCode: retained.accountCode, accountName: retained.accountName,
      debit: transfer < 0 ? -transfer : 0,
      credit: transfer > 0 ? transfer : 0,
    });
  }

  return {
    entryDate,
    entryNumber: `YE-${yearLabel}`,
    description: `Year-End Closing: ${yearLabel}`,
    lines,
    totalDebit: lines.reduce((s, l) => s + l.debit, 0),
    totalCredit: lines.reduce((s, l) => s + l.credit, 0),
  };
}

