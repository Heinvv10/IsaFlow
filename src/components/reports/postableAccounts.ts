/**
 * Which chart accounts an account-picker may offer for a ledger report: the
 * report's own leaf rule (balanceSheetService, trendRowsService: `level >= 3 OR
 * no children`, see gl/isReportVisibleLeaf) plus any account that carries
 * postings, whatever its level. A Sage-imported chart has its leaves at level
 * 1 or 2, so a bare `level >= 3` filter hides accounts with money on them; a
 * level 1-2 account WITH children and no postings of its own is a header and
 * stays out. Client-side twin of the SQL, fed by the chart-of-accounts list.
 */
export interface ChartRow {
  id: string;
  parentAccountId?: string | null;
  level?: number | null;
  hasTransactions?: boolean;
}

const BALANCE_SHEET_LEAF_LEVEL = 3;

export function postableAccounts<T extends ChartRow>(accounts: T[]): T[] {
  const parents = new Set(accounts.map(a => a.parentAccountId).filter((p): p is string => !!p));
  return accounts.filter(a =>
    a.hasTransactions === true
    || a.level == null
    || a.level >= BALANCE_SHEET_LEAF_LEVEL
    || !parents.has(a.id));
}
