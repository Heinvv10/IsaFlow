/**
 * Actual P&L months for a three-way run (P6 spec §5 lookback, §4 derive, §13.8;
 * T10). Read-only, and only through P3's `readTrackingActuals` (the contract:
 * P6 reads actuals through it): posted, year-end close left out, company-scoped,
 * natural sign. Two month lists come from ONE read:
 *   - the engine's lookback: the 12 months before the version's first month;
 *   - the derive's trailing window: the 12 whole months ending on or before the
 *     opening as-at (the same months unless the opening is provisional).
 * A month with no posting is 0 (and inactive). The read ends at the opening
 * as-at: on a provisional opening (decision 10a) lookback months after it read
 * as 0, forward-dated postings included, and the opening_provisional warning covers it.
 */
import { readTrackingActuals } from '@/modules/accounting/services/budgets/tracking/trackingActualRead';
import { readTrackingBudgets } from '@/modules/accounting/services/budgets/tracking/trackingBudgetRead';
import { monthOrdinal, addMonths } from './months';
import {
  foldActuals, foldPnl, lookbackMonthsBefore, monthLastDay, toLookback, trailingMonthsTo, type ActualMonth,
} from './threeWayFolds';
import type { LookbackMonth, PnlMonth } from './types';

/** Lookback and trailing window length (spec §5: ≥ 12 months wanted). */
export const LOOKBACK_MONTHS = 12;

export interface ActualsRead {
  lookback: LookbackMonth[];
  /** The derive's trailing months (oldest first), with payroll and activity. */
  trailing: ActualMonth[];
}

/** Actual months over `months`, read to their last day or to `through` ('YYYY-MM-DD') when that is earlier. */
export async function readActualMonths(companyId: string, months: readonly string[], through?: string): Promise<ActualMonth[]> {
  if (months.length === 0) return [];
  const last = monthLastDay(months[months.length - 1] as string);
  const rows = await readTrackingActuals(companyId, `${months[0]}-01`, through !== undefined && through < last ? through : last);
  return foldActuals(rows.map((r) => ({ accountType: r.accountType, accountSubtype: r.accountSubtype, month: r.month, amount: r.amount })), months);
}

export async function readActuals(companyId: string, firstMonth: string, asAt: string): Promise<ActualsRead> {
  const lookbackMonths = lookbackMonthsBefore(firstMonth, LOOKBACK_MONTHS);
  const trailingMonths = trailingMonthsTo(asAt, LOOKBACK_MONTHS);
  const from = monthOrdinal(trailingMonths[0] as string) < monthOrdinal(lookbackMonths[0] as string) ? trailingMonths[0] as string : lookbackMonths[0] as string;
  const to = lookbackMonths[lookbackMonths.length - 1] as string;
  const span = monthOrdinal(to) - monthOrdinal(from) + 1;
  // Clamped at the as-at: on a provisional opening a posting dated after it (forward-dated) never enters the window.
  const all = await readActualMonths(companyId, Array.from({ length: span }, (_, i) => addMonths(from, i)), asAt);
  const byMonth = new Map(all.map((m) => [m.month, m]));
  const pick = (ms: readonly string[]) => ms.map((m) => byMonth.get(m) as ActualMonth);
  return { lookback: toLookback(pick(lookbackMonths)), trailing: pick(trailingMonths) };
}

/** The version's stored budget per month by engine band (cents), through P3's `readTrackingBudgets`. */
export async function readVersionPnl(companyId: string, fiscalYear: number, versionId: string, months: readonly string[]): Promise<PnlMonth[]> {
  const rows = await readTrackingBudgets(companyId, [{
    fiscalYear, versionId, first: `${months[0]}-01`, last: `${months[months.length - 1]}-01`,
  }]);
  return foldPnl(rows.map((r) => ({ accountType: r.accountType, accountSubtype: r.accountSubtype, month: r.month, amount: r.amount })), months);
}
