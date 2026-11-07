/**
 * Supplier statement reconciliation — our side of the variance.
 *
 * Shared by the background extraction job (first measurement) and Rematch
 * (re-measurement), so both strike the figure the same way.
 */

import { getAPAgingDetail } from '@/modules/accounting/services/ap/apAgingService';
import { openingBalanceAsAt, openingBalanceIndexes, type ClassifiableLine } from './supplierStatementOpeningBalance';

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
 * A brought-forward line's figure: debit less credit, or, when it carries neither (some layouts print the B/F
 * figure only in the balance column), its running balance.
 */
export function openingLineAmount(l: { debit: number; credit: number; runningBalance: number | null }): number {
  if (l.debit === 0 && l.credit === 0 && l.runningBalance !== null) return l.runningBalance;
  return l.debit - l.credit;
}

export interface OpeningBalanceCheck {
  /** The day IsaFlow's side is measured at: the day before the first dated transaction line. */
  asAt: string;
  /** The statement's brought-forward figure: its opening line(s), debit less credit (else running balance). */
  statementAmount: number;
  isaflowBalance: number;
  /** statementAmount − isaflowBalance. */
  variance: number;
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
  statementDate: string,
  lines: (ClassifiableLine & { debit: number; credit: number; runningBalance: number | null })[],
): Promise<OpeningBalanceCheck | null> {
  const opening = openingBalanceIndexes(lines);
  if (opening.size === 0) return null;
  const statementAmount = Math.round([...opening].reduce((s, i) => s + openingLineAmount(lines[i]!), 0) * 100) / 100;
  const asAt = openingBalanceAsAt(lines, opening, statementDate);
  const { isaflowBalance, variance } = await measureOurSide(companyId, supplierId, asAt, statementAmount);
  return { asAt, statementAmount, isaflowBalance, variance };
}
