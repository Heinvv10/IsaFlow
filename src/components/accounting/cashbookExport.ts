/**
 * The query of the Cashbook page's CSV export (GET /api/accounting/bank-transactions-export): the route takes
 * `account_code`, `period_start` and `period_end`. The page used to send `bank_account_id`, `from` and `to`, which the
 * route does not read, so the export never followed the page's account or dates.
 */
export function cashbookExportParams(
  accounts: Array<{ id: string; accountCode: string }>, selectedBankId: string, from: string, to: string,
): Record<string, string> {
  const account = accounts.find(a => a.id === selectedBankId);
  return { ...(account ? { account_code: account.accountCode } : {}), period_start: from, period_end: to };
}
