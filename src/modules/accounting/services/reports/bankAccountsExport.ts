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
 *  - statements from bank/latestStatementService.getLatestStatements: the
 *    latest statement date entered on a reconciliation of the account (any
 *    status) and the closing balance typed from that statement;
 *    Last_Reconciled_Date is the latest COMPLETED reconciliation's statement
 *    date. Where Last_Statement_Date is later than Last_Reconciled_Date, that
 *    statement sits on a reconciliation still in progress — its balance is
 *    the bank's figure, but nobody has signed the reconciliation off.
 *
 * Account_Number_Masked keeps the last four characters only, and only when at
 * least four more stay hidden; a shorter number is '****' alone.
 */

import { fmtDate } from '@/lib/fmtDate';
import { getBankAccountsStatus } from '@/modules/accounting/services/bank/bankAccountStatusService';
import { getCashBalance } from '@/modules/accounting/services/bank/cashBalanceService';
import { getLatestStatements } from '@/modules/accounting/services/bank/latestStatementService';
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

/** Fewest characters a number must have before its last four are shown: four must stay hidden. */
const MIN_REVEAL_LENGTH = 8;

/** '****' and the last four characters (a number under eight characters: '****' alone); blank when none is captured. */
export function maskAccountNumber(raw: string | null): string | null {
  const s = (raw ?? '').replace(/\s+/g, '');
  if (s === '') return null;
  return s.length < MIN_REVEAL_LENGTH ? '****' : `****${s.slice(-4)}`;
}

/** Every bank / card account, ordered by id. Reads run SEQUENTIALLY: one pg client per request. */
export async function buildBankAccounts(
  companyId: string,
  asAtStr: string = fmtDate(new Date()),
): Promise<BankAccountsResult> {
  const accounts = await getBankAccountsStatus(companyId, { includeInactive: true });
  const cash = await getCashBalance(companyId, asAtStr);
  const statements = await getLatestStatements(companyId);

  const ledger = new Map(cash.accounts.map((a) => [a.accountId, a.glBalance]));

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
        Last_Statement_Date: st?.lastStatementDate ?? null,
        Last_Statement_Closing_Balance: st?.lastStatementBalance ?? null,
        Last_Reconciled_Date: st?.lastReconciledDate ?? null,
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
