/**
 * The opening and closing rows of ONE page of the account ledger — shared by the screen
 * (AccountLedgerTable) and the CSV so they cannot disagree. Page 1 opens at the ledger's
 * opening balance; a later page opens at the balance its first row started from (derived
 * year-end close rows included), i.e. the previous page's carried-forward balance. Only the
 * last page closes at the period closing balance; earlier pages carry their last row forward.
 */

import { toMoney } from '@/lib/money/decimalSum';
import type { AccountLedgerRow } from '@/modules/accounting/services/reports/accountLedgerTypes';

export interface LedgerPageBoundaries {
  openingLabel: string;
  opening: number;
  closingLabel: string;
  closing: number;
}

export function ledgerPageBoundaries(
  normalBalance: string,
  rows: readonly AccountLedgerRow[],
  openingBalance: number,
  periodClosingBalance: number,
  page: number,
  totalPages: number,
): LedgerPageBoundaries {
  const first = rows[0];
  const last = rows[rows.length - 1];
  const fromPrevious = page > 1 && first !== undefined;
  const carriesForward = page < totalPages && last !== undefined;
  return {
    openingLabel: fromPrevious ? 'Balance Brought Forward' : 'Opening Balance',
    opening: fromPrevious
      ? toMoney(first.runningBalance - (normalBalance === 'debit' ? first.debit - first.credit : first.credit - first.debit))
      : openingBalance,
    closingLabel: carriesForward ? 'Balance Carried Forward' : 'Closing Balance',
    closing: carriesForward ? last.runningBalance : periodClosingBalance,
  };
}
