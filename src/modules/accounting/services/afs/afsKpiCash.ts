// src/modules/accounting/services/afs/afsKpiCash.ts
/**
 * The KPI block's cash figures, on the SAME definition the cash-flow statement
 * uses. Their own file because `afsKpiService` is at the 300-line limit and
 * because the definition — not the KPI arithmetic — is the thing that has to
 * stay in step with `cashBalanceService`.
 */
import { getCashBalance } from '../bank/cashBalanceService';

/**
 * Opening cash, on the SAME definition the cash-flow statement uses:
 * `cash.balance.v1` (`getCashBalance`), read exclusively of `beforeDate`.
 *
 * The literal `account_subtype = 'bank'` missed petty cash (subtype `cash`) and
 * counted a credit card spelled `bank_account` as cash, so the KPI block and the
 * cash-flow reconciliation printed beside it in the same AFS export disagreed by
 * exactly those balances. Its own copy of the query then signed each account by
 * its user-set `normal_balance`, summing a credit-normal petty cash float as
 * negative cash (K-091g). Reading `getCashBalance` leaves one definition.
 */
export async function fetchOpeningCash(companyId: string, beforeDate: string): Promise<number> {
  return (await getCashBalance(companyId, beforeDate, { exclusive: true })).total;
}

export async function fetchClosingCash(companyId: string, upToDate: string): Promise<number> {
  return (await getCashBalance(companyId, upToDate)).total;
}
