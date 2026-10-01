/** Debit/credit totals over POSTED rows only: a derived year-end close row is not in the ledger, so adding it would stop the totals tying to the income statement. */
export function postedTotals(rows: ReadonlyArray<{ debit: number; credit: number; derived?: boolean }>): { debit: number; credit: number } {
  return rows.filter(r => !r.derived).reduce((t, r) => ({ debit: t.debit + r.debit, credit: t.credit + r.credit }), { debit: 0, credit: 0 });
}

/** Account count for the General Ledger page: posted accounts only, not the derived RE-BF row. */
export function countPostedAccounts(accounts: ReadonlyArray<{ derived?: boolean }>): number {
  return accounts.filter(a => !a.derived).length;
}
