/**
 * VAT periods and settlement months (P6 spec §5 step 11, T3).
 *
 * Semantics are `bureau/services/vatPeriodHelper`'s (pinned by the T3 table
 * test against `vatQuickPeriods`): monthly (Category C) = one month; bi-monthly
 * 'odd' (Category A) = periods ENDING in Jan/Mar/May/Jul/Sep/Nov, 'even'
 * (Category B) = ENDING in Feb/Apr/…/Dec. Categories D/E (6-monthly, annual)
 * are not representable: the cadence type has no value for them (§3 Out).
 *
 * A payable period is due the month after it ends (the 25th or last business
 * day both fall in m+1 at monthly grain, §1); a refund arrives `lag` months
 * after the end (`vat.refundLagMonths`, 0..2).
 */
import { addMonths, monthNumber } from './months';

export type VatCadence = 'monthly' | 'bi-monthly';
export type VatAlignment = 'odd' | 'even';

/** A VAT period as first and last month ('YYYY-MM'). */
export interface VatPeriodRef {
  start: string;
  end: string;
}

/** The VAT period `month` belongs to. */
export function vatPeriodOf(month: string, cadence: VatCadence, alignment: VatAlignment): VatPeriodRef {
  if (cadence === 'monthly') return { start: month, end: month };
  const endsHere = (monthNumber(month) % 2 === 1) === (alignment === 'odd');
  return endsHere ? { start: addMonths(month, -1), end: month } : { start: month, end: addMonths(month, 1) };
}

/** The month a payable period is paid in. */
export function vatDueMonth(period: VatPeriodRef): string {
  return addMonths(period.end, 1);
}

/** The settlement month of a period's net (liability-positive): payable due m+1, refund m+lag. */
export function vatSettleMonth(period: VatPeriodRef, net: number, refundLagMonths: number): string {
  return net >= 0 ? vatDueMonth(period) : addMonths(period.end, refundLagMonths);
}
