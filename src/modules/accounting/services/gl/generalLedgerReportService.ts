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

type Row = Record<string, unknown>;

export interface GeneralLedgerTransaction {
  date: string;
  entryNumber: string;
  description: string;
  debit: number;
  credit: number;
  balance: number;
  source: string;
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
  try {
    const acctRows = (await sql`
      SELECT account_code, account_name, account_type, normal_balance
      FROM gl_accounts
      WHERE company_id = ${companyId}::UUID
      ORDER BY account_code
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

    // Opening balances: everything posted before the window, per account.
    const obRows = (await sql`
      SELECT ga.account_code,
             COALESCE(SUM(jl.debit), 0)  AS total_debit,
             COALESCE(SUM(jl.credit), 0) AS total_credit
      FROM gl_journal_lines jl
      JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
      JOIN gl_accounts ga ON ga.id = jl.gl_account_id
      WHERE je.status = 'posted'
        AND je.company_id = ${companyId}::UUID
        AND jl.company_id = ${companyId}::UUID
        AND ga.company_id = ${companyId}::UUID
        AND je.entry_date < ${periodStart}
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
      WHERE je.status = 'posted'
        AND je.company_id = ${companyId}::UUID
        AND jl.company_id = ${companyId}::UUID
        AND ga.company_id = ${companyId}::UUID
        AND je.entry_date >= ${periodStart}
        AND je.entry_date <= ${periodEnd}
      ORDER BY ga.account_code, je.entry_date, je.created_at
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

    return Array.from(byAccount.values()).sort((a, b) =>
      a.accountCode.localeCompare(b.accountCode)
    );
  } catch (err) {
    log.error('Failed to generate general ledger report', { error: err }, 'accounting');
    throw err;
  }
}
