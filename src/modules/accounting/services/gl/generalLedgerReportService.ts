/**
 * General Ledger report — every account for a period, in three queries.
 *
 * Replaces the page-level fan-out that issued ONE request per account from the
 * browser. That design forced a `accounts.slice(0, 20)` cap (issue #287): with
 * 269 accounts on the largest tenant it would otherwise have fired 269 parallel
 * requests. The cap silently truncated the report — a period holding 419 posted
 * lines across 29 accounts rendered as "No account activity" because every
 * account with movement sorted past position 20.
 *
 * Query count here is constant, not O(accounts): one for the account list, one
 * for opening balances, one for in-period lines.
 */

import { sql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { log } from '@/lib/logger';
import { toMoney } from '@/lib/money/decimalSum';
import { DEFAULT_FY_START_MONTH, fiscalYearStart, resolveFiscalYearStartMonth } from './fiscalYearBasis';
import { broughtForwardLine, getRetainedEarningsBroughtForward, INCOME_STATEMENT_TYPES } from './trialBalanceBasis';
import { withYearEndCloses } from './generalLedgerReportYearEnd';
import { assertLedgerRange } from './ledgerDateRange';
import { YEAR_END_JOURNAL_SOURCE } from '@/modules/accounting/services/gl/yearEndJournalSource';

type Row = Record<string, unknown>;

export interface GeneralLedgerTransaction {
  date: string;
  entryNumber: string;
  description: string;
  debit: number;
  credit: number;
  balance: number;
  source: string;
  /** A year-end close row: derived, not posted. */
  derived?: boolean;
}

export interface GeneralLedgerAccountReport {
  accountCode: string;
  accountName: string;
  accountType: string;
  openingBalance: number;
  closingBalance: number;
  totalDebit: number;
  totalCredit: number;
  transactions: GeneralLedgerTransaction[];
  /** The Retained Earnings b/f row (trialBalanceBasis RE-BF): computed, no account behind it. */
  derived?: boolean;
}

interface AccountMeta {
  code: string;
  name: string;
  type: string;
  normalBalance: string;
}

/** Signed movement for one line, in the direction the account normally carries. */
function signed(normalBalance: string, debit: number, credit: number): number {
  return normalBalance === 'debit' ? debit - credit : credit - debit;
}

/**
 * Every account carrying activity or an opening balance in [periodStart, periodEnd].
 *
 * Accounts with neither are omitted — they contribute nothing to a ledger and
 * listing all 269 would bury the ones that matter. That filter is applied AFTER
 * fetching, so it is a property of the data rather than of an arbitrary cap.
 */
export async function getGeneralLedgerReport(
  companyId: string,
  periodStart: string,
  periodEnd: string
): Promise<GeneralLedgerAccountReport[]> {
  assertLedgerRange(periodStart, periodEnd);
  try {
    const acctRows = (await sql`
      SELECT ga.account_code, ga.account_name, ga.account_type, ga.normal_balance,
             c.financial_year_start
      FROM gl_accounts ga
      LEFT JOIN companies c ON c.id = ga.company_id
      WHERE ga.company_id = ${companyId}::UUID
      ORDER BY ga.account_code
    `) as Row[];

    const accounts = new Map<string, AccountMeta>();
    for (const r of acctRows) {
      accounts.set(String(r.account_code), {
        code: String(r.account_code),
        name: String(r.account_name || ''),
        type: String(r.account_type || ''),
        normalBalance: String(r.normal_balance || 'debit'),
      });
    }
    if (accounts.size === 0) return [];

    // Income-statement accounts restart at the fiscal-year start (trialBalanceBasis):
    // their opening is floored at the start of the fiscal year containing periodStart.
    // READ PATH: March fallback taken visibly, as the trial balance does.
    const fyStartMonth = resolveFiscalYearStartMonth(
      acctRows[0]?.financial_year_start, companyId, { fallback: DEFAULT_FY_START_MONTH },
    );
    const fyStart = fiscalYearStart(periodStart, fyStartMonth);

    // Opening balances: everything posted before the window, per account
    // (income-statement accounts: only since fyStart).
    const obRows = (await sql`
      SELECT ga.account_code,
             COALESCE(SUM(jl.debit), 0)  AS total_debit,
             COALESCE(SUM(jl.credit), 0) AS total_credit
      FROM gl_journal_lines jl
      JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
      JOIN gl_accounts ga ON ga.id = jl.gl_account_id
      WHERE je.status = 'posted' AND je.source IS DISTINCT FROM ${YEAR_END_JOURNAL_SOURCE}
        AND je.company_id = ${companyId}::UUID
        AND jl.company_id = ${companyId}::UUID
        AND ga.company_id = ${companyId}::UUID
        AND je.entry_date < ${periodStart}
        AND (ga.account_type <> ALL(${[...INCOME_STATEMENT_TYPES]}::text[]) OR je.entry_date >= ${fyStart})
      GROUP BY ga.account_code
    `) as Row[];

    const opening = new Map<string, number>();
    for (const r of obRows) {
      const meta = accounts.get(String(r.account_code));
      if (!meta) continue;
      opening.set(
        String(r.account_code),
        signed(meta.normalBalance, Number(r.total_debit || 0), Number(r.total_credit || 0))
      );
    }

    // In-period lines for every account at once. Ordered so the running balance
    // can be accumulated in a single pass per account.
    const txnRows = (await sql`
      SELECT ga.account_code,
             je.entry_date, je.entry_number, je.description, je.source,
             jl.debit, jl.credit
      FROM gl_journal_lines jl
      JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
      JOIN gl_accounts ga ON ga.id = jl.gl_account_id
      WHERE je.status = 'posted' AND je.source IS DISTINCT FROM ${YEAR_END_JOURNAL_SOURCE}
        AND je.company_id = ${companyId}::UUID
        AND jl.company_id = ${companyId}::UUID
        AND ga.company_id = ${companyId}::UUID
        AND je.entry_date >= ${periodStart}
        AND je.entry_date <= ${periodEnd}
      ORDER BY ga.account_code, je.entry_date, COALESCE(je.created_at, 'epoch'::timestamptz), jl.id
    `) as Row[];

    const byAccount = new Map<string, GeneralLedgerAccountReport>();

    const ensure = (code: string): GeneralLedgerAccountReport | null => {
      const meta = accounts.get(code);
      if (!meta) return null;
      let rep = byAccount.get(code);
      if (!rep) {
        const ob = opening.get(code) ?? 0;
        rep = {
          accountCode: meta.code,
          accountName: meta.name,
          accountType: meta.type,
          openingBalance: ob,
          closingBalance: ob,
          totalDebit: 0,
          totalCredit: 0,
          transactions: [],
        };
        byAccount.set(code, rep);
      }
      return rep;
    };

    for (const r of txnRows) {
      const code = String(r.account_code);
      const rep = ensure(code);
      if (!rep) continue;
      const meta = accounts.get(code)!;
      const debit = Number(r.debit || 0);
      const credit = Number(r.credit || 0);
      rep.closingBalance += signed(meta.normalBalance, debit, credit);
      rep.totalDebit += debit;
      rep.totalCredit += credit;
      rep.transactions.push({
        date: fmtDate(r.entry_date),
        entryNumber: String(r.entry_number || ''),
        description: String(r.description || ''),
        debit,
        credit,
        balance: rep.closingBalance,
        source: String(r.source || 'manual'),
      });
    }

    // Accounts with an opening balance but no movement still belong in a ledger.
    for (const [code, ob] of opening) {
      if (ob !== 0) ensure(code);
    }

    // The profit earned before fyStart left the income-statement openings above;
    // it re-enters as a derived Retained Earnings b/f row (the TB's RE-BF), so the
    // ledger's openings still net to zero. Closes inside the range land there too.
    const retainedBf = await getRetainedEarningsBroughtForward(companyId, fyStart);
    const reports = withYearEndCloses(Array.from(byAccount.values()), {
      accounts, periodStart, periodEnd, fyStartMonth,
      retainedEarnings: { ...broughtForwardLine(fyStart), openingBalance: retainedBf },
    });
    // Money leaves the service rounded to cents, as the sibling listings do (toMoney).
    return reports
      .map(r => ({
        ...r,
        openingBalance: toMoney(r.openingBalance), closingBalance: toMoney(r.closingBalance),
        totalDebit: toMoney(r.totalDebit), totalCredit: toMoney(r.totalCredit),
        transactions: r.transactions.map(t => ({ ...t, balance: toMoney(t.balance) })),
      }))
      .sort((a, b) => a.accountCode.localeCompare(b.accountCode));
  } catch (err) {
    log.error('Failed to generate general ledger report', { error: err }, 'accounting');
    throw err;
  }
}
