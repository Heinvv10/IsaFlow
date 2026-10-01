/** Account count for the General Ledger page: posted accounts only, not the derived RE-BF row. */
export function countPostedAccounts(accounts: ReadonlyArray<{ derived?: boolean }>): number {
  return accounts.filter(a => !a.derived).length;
}
