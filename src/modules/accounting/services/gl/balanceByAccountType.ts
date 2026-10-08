/**
 * The sign of a balance-sheet account's balance: by its ACCOUNT TYPE, never by
 * its `normal_balance`. An asset is debit less credit; a liability or equity
 * account is credit less debit.
 *
 * `normal_balance` is user-set (the account API, CSV import) and is legitimately
 * "wrong" for a contra account: Accumulated Depreciation is a credit-normal
 * asset, Dividends Declared or Drawings a debit-normal equity account. Signed by
 * that column, each contra balance is ADDED to its section instead of reducing
 * it — Sample Trading's equity was overstated by twice its R2.53m of dividends.
 * Signed by type, a contra account comes out negative under its own section.
 *
 * The balance sheet, its trend series, the consolidated balance sheet and the
 * subledger control balances all sign through this one function.
 *
 * @param netDebit debit less credit, as posted.
 */
export function balanceByAccountType(accountType: string, netDebit: number): number {
  return accountType === 'asset' ? netDebit : -netDebit;
}
