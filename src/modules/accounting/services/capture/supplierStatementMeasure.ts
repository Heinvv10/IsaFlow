/**
 * Supplier statement reconciliation — our side of the variance.
 *
 * Shared by the background extraction job (first measurement) and Rematch
 * (re-measurement), so both strike the figure the same way.
 */

import { getAPAgingDetail } from '@/modules/accounting/services/ap/apAgingService';

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
