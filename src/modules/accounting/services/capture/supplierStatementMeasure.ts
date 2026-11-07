/**
 * Supplier statement reconciliation — our side of the variance.
 *
 * Shared by the background extraction job (first measurement) and Rematch
 * (re-measurement), so both strike the figure the same way.
 */

import { getAPAgingDetail } from '@/modules/accounting/services/ap/apAgingService';
import {
  openingBalanceAsAt,
  openingBalanceIndexes,
  type ClassifiableLine,
  type OpeningBalanceCheck,
} from './supplierStatementOpeningBalance';

export type { OpeningBalanceCheck };

/**
 * Our side of the variance: what we owed this supplier ON THE STATEMENT DATE —
 * the date the supplier's closing balance is struck at — from the AP ageing's
 * own rewind (R-059). It used to be today's si.balance over every non-paid,
 * non-cancelled bill, drafts included: a payment made after the statement date
 * showed as a variance the supplier could never explain, and a bill raised
 * after it was compared against a statement that predates it.
 *
 * The ONE place this is computed. The extraction job and Rematch both call it, because a
 * variance struck once and then kept while the lines are re-matched against
 * today's bills is a figure from a different moment than the counts beside it
 * (R-059 round 10).
 */
export async function measureOurSide(
  companyId: string,
  supplierId: string,
  statementDate: string,
  supplierBalance: number,
): Promise<{ isaflowBalance: number; variance: number }> {
  const aged = await getAPAgingDetail(companyId, supplierId, statementDate);
  const isaflowBalance = Math.round(aged.invoices.reduce((s, inv) => s + inv.balance, 0) * 100) / 100;
  const variance = Math.round((supplierBalance - isaflowBalance) * 100) / 100;
  return { isaflowBalance, variance };
}

/**
 * A brought-forward line's figure: its running balance, which on the opening line IS the balance brought forward,
 * else debit less credit. The balance column wins because layouts disagree on the amount columns: many print the
 * B/F figure only in the balance column, and on prod Demo's Engen statement (2026-11-07) the extracted debit was
 * 19,743.55 while the balance column, which every later line's running balance chains from, said 427,728.14.
 */
export function openingLineAmount(l: { debit: number; credit: number; runningBalance: number | null }): number {
  const net = l.debit - l.credit;
  const balance = l.runningBalance;
  // The amount columns win only where the balance cell cannot be the figure: absent, or beside an amount but not of
  // its sign — a blank read as 0 (sign 0), or an unsigned credit balance printed "500 Cr".
  if (balance === null || (net !== 0 && Math.sign(balance) !== Math.sign(net))) return net;
  return balance;
}

/**
 * The opening-balance check of a statement's "Balance brought forward" line (Hein, 2026-11-07, D1): the
 * supplier's brought-forward figure against what IsaFlow owed the supplier the day before the first transaction,
 * struck by measureOurSide, the same AP ageing the closing variance uses. Null when the statement has no
 * opening-balance line. `lines` are the statement's own lines (not the synthetic "missing in statement" rows).
 */
export async function measureOpeningBalance(
  companyId: string,
  supplierId: string,
  lines: (ClassifiableLine & { debit: number; credit: number; runningBalance: number | null })[],
): Promise<OpeningBalanceCheck | null> {
  const opening = openingBalanceIndexes(lines);
  if (opening.size === 0) return null;
  const statementAmount = Math.round(openingLineAmount(lines[[...opening][0]!]!) * 100) / 100;
  const asAt = openingBalanceAsAt(lines, opening);
  const { isaflowBalance, variance } = await measureOurSide(companyId, supplierId, asAt, statementAmount);
  return { asAt, statementAmount, isaflowBalance, variance };
}
