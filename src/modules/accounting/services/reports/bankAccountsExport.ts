/**
 * `bank_accounts` — one row per bank / card GL account, for a dashboard that
 * shows where each account stands. Nothing is derived here; every figure comes
 * from the service that owns it:
 *
 *  - the account list, line counts and last transaction date from
 *    bank/bankAccountStatusService.getBankAccountsStatus — the Banking screen's
 *    list and the bank_accounts_status tool, inactive accounts INCLUDED (this
 *    is a question about money). Unreconciled_Line_Count is its
 *    unreconciledCount (posted feed lines still imported or allocated, not
 *    reconciled); Unallocated_Line_Count its unallocatedCount (no journal, no
 *    category, not excluded); Last_Transaction_Date its last posted feed line.
 *  - Ledger_Balance from bank/cashBalanceService.getCashBalance
 *    (`cash.balance.v1`, posted GL debit less credit up to today). That figure
 *    counts asset-typed accounts only, so an account it does not hold — a
 *    credit card kept on a liability account — exports a BLANK balance rather
 *    than a number from a second definition.
 *  - statements from bank/bankReconciliationService.getReconciliations: the
 *    latest statement date entered on a reconciliation of the account (any
 *    status) and its closing balance; Last_Reconciled_Date is the latest
 *    COMPLETED reconciliation's statement date.
 *
 * Account_Number_Masked keeps the last four characters only.
 */

import { fmtDate } from '@/lib/fmtDate';
import { getBankAccountsStatus } from '@/modules/accounting/services/bank/bankAccountStatusService';
import { getCashBalance } from '@/modules/accounting/services/bank/cashBalanceService';
import { getReconciliations } from '@/modules/accounting/services/bank/bankReconciliationService';
import type { ExportValue } from './glLineExportRows';

export const BANK_ACCOUNTS_SCHEMA_VERSION = 'isaflow-bank-accounts-1.0';

export const BANK_ACCOUNTS_COLUMNS: readonly string[] = [
  'Bank_Account_ID', 'GL_Account_Code', 'Name', 'Account_Number_Masked', 'Currency', 'Ledger_Balance',
  'Last_Statement_Date', 'Last_Statement_Closing_Balance', 'Last_Reconciled_Date',
  'Unreconciled_Line_Count', 'Unallocated_Line_Count', 'Last_Transaction_Date', 'Is_Active', 'Schema_Version',
];

export type BankAccountsRow = Record<string, ExportValue>;

export interface BankAccountsSummary {
  table: 'bank_accounts';
  schemaVersion: string;
  asAt: string;
  rowCount: number;
  /** Σ Ledger_Balance over the rows that carry one. */
  controlTotal: number;
  /** Rows with a blank Ledger_Balance (not an asset-typed cash account). */
  noLedgerBalanceCount: number;
  unreconciledLineCount: number;
  unallocatedLineCount: number;
}

export interface BankAccountsResult {
  columns: readonly string[];
  rows: BankAccountsRow[];
  summary: BankAccountsSummary;
}

/** '****' and the last four characters; blank when no number is captured. */
export function maskAccountNumber(raw: string | null): string | null {
  const s = (raw ?? '').replace(/\s+/g, '');
  if (s === '') return null;
  return `****${s.slice(-4)}`;
}

interface StatementFacts { lastDate: string; lastBalance: number; lastReconciled: string | null }

/** Per bank account: the latest statement on any reconciliation and the latest completed one. */
function statementFacts(
  recons: ReadonlyArray<{ bankAccountId: string; statementDate: string; statementBalance: number; status: string }>,
): Map<string, StatementFacts> {
  const out = new Map<string, StatementFacts>();
  for (const r of recons) {
    const cur = out.get(r.bankAccountId);
    const completed = r.status === 'completed';
    const next: StatementFacts = cur ?? { lastDate: r.statementDate, lastBalance: r.statementBalance, lastReconciled: null };
    // Latest statement wins; on a tie a completed session's balance wins.
    if (cur && (r.statementDate > cur.lastDate || (r.statementDate === cur.lastDate && completed))) {
      next.lastDate = r.statementDate;
      next.lastBalance = r.statementBalance;
    }
    if (completed && (next.lastReconciled === null || r.statementDate > next.lastReconciled)) {
      next.lastReconciled = r.statementDate;
    }
    out.set(r.bankAccountId, next);
  }
  return out;
}

/** Every bank / card account, ordered by id. Reads run SEQUENTIALLY: one pg client per request. */
export async function buildBankAccounts(
  companyId: string,
  asAtStr: string = fmtDate(new Date()),
): Promise<BankAccountsResult> {
  const accounts = await getBankAccountsStatus(companyId, { includeInactive: true });
  const cash = await getCashBalance(companyId, asAtStr);
  const recons = await getReconciliations(companyId);

  const ledger = new Map(cash.accounts.map((a) => [a.accountId, a.glBalance]));
  const statements = statementFacts(recons);

  const rows: BankAccountsRow[] = accounts
    .map((a): BankAccountsRow => {
      const st = statements.get(a.id);
      return {
        Bank_Account_ID: a.id,
        GL_Account_Code: a.accountCode,
        Name: a.accountName,
        Account_Number_Masked: maskAccountNumber(a.bankAccountNumber),
        // Bank accounts are ZAR-only (bank_accounts_currency_zar, companies_functional_currency_zar).
        Currency: 'ZAR',
        Ledger_Balance: ledger.get(a.id) ?? null,
        Last_Statement_Date: st?.lastDate ?? null,
        Last_Statement_Closing_Balance: st?.lastBalance ?? null,
        Last_Reconciled_Date: st?.lastReconciled ?? null,
        Unreconciled_Line_Count: a.unreconciledCount,
        Unallocated_Line_Count: a.unallocatedCount,
        Last_Transaction_Date: a.lastDate,
        Is_Active: a.isActive === true,
        Schema_Version: BANK_ACCOUNTS_SCHEMA_VERSION,
      };
    })
    .sort((x, y) => (String(x.Bank_Account_ID) < String(y.Bank_Account_ID) ? -1 : 1));

  const withBalance = rows.filter((r) => r.Ledger_Balance !== null);
  return {
    columns: BANK_ACCOUNTS_COLUMNS,
    rows,
    summary: {
      table: 'bank_accounts',
      schemaVersion: BANK_ACCOUNTS_SCHEMA_VERSION,
      asAt: asAtStr,
      rowCount: rows.length,
      controlTotal: withBalance.reduce((s, r) => s + Math.round((r.Ledger_Balance as number) * 100), 0) / 100 || 0,
      noLedgerBalanceCount: rows.length - withBalance.length,
      unreconciledLineCount: rows.reduce((s, r) => s + (r.Unreconciled_Line_Count as number), 0),
      unallocatedLineCount: rows.reduce((s, r) => s + (r.Unallocated_Line_Count as number), 0),
    },
  };
}
