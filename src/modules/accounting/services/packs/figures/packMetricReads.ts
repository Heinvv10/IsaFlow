/**
 * The readings shared between the highlights strip (page 3) and the
 * scorecard (page 9), so that one figure source has exactly ONE reading.
 *
 * This module exists because of a real defect, not for tidiness. Page 3 and
 * page 9 both show debtor days and debt-to-equity, and both record them
 * against the same `PackFigureProvenance` source. Two independent readings of
 * one source is not a cosmetic duplication: the moment they differ,
 * `assertConsistent()` throws and the pack does not render at all. The same
 * hazard bit `operatingProfit`, which one side read as null-with-a-reason and
 * the other as the classifier's documented fallback.
 *
 * Everything here follows the R-P44 / R-P45 doctrine: a figure whose value is
 * an artefact of an impossible denominator is not a measurement, and is
 * reported as unavailable with a reason rather than as a number.
 */

import type { ExtendedRatioResult } from '@/modules/accounting/services/reports/reportingEngineService';
import type { ReportPackFigures } from '@/modules/accounting/services/reports/reportPackDataService';

/** A value, or the reason there isn't one, plus the basis of a percentage. */
export interface PackMetricRead {
  value: number | null;
  unavailable?: string;
  basis?: { numerator: number; denominator: number };
}

/**
 * `debtorDays` is receivables over revenue. On non-positive revenue the
 * quotient's sign stops tracking the story: Brightsphere's net-debit revenue
 * printed "−4 days", which reads as a debtor book collected before the sale
 * and is not a statement about anything. Same class as R-P44 and R-P45 —
 * except that this one arrives NEGATIVE rather than merely wrong, so a reader
 * cannot even take it as an optimistic reading.
 */
export const DEBTOR_DAYS_SOURCE = 'calculateExtendedRatios.debtorDays';

export function readDebtorDays(ratios: ExtendedRatioResult, raw: ReportPackFigures): PackMetricRead {
  if (raw.revenue <= 0) {
    return {
      value: null,
      unavailable: 'Revenue is not positive, so days of sales outstanding cannot be measured.',
    };
  }
  return { value: ratios.debtorDays };
}

export const DEBT_TO_EQUITY_SOURCE = 'calculateExtendedRatios.debtToEquity';

/** The engine already refuses this ratio on non-positive equity (AN-07) and
 *  states its own reason; that reason is read, never re-worded here. */
export function readDebtToEquity(ratios: ExtendedRatioResult): PackMetricRead {
  return ratios.debtToEquity === null
    ? {
        value: null,
        unavailable:
          ratios.notMeaningful.debtToEquity ?? 'Equity is not positive, so this ratio has no meaning.',
      }
    : { value: ratios.debtToEquity };
}

/**
 * The operating line, from the classifier where it exists and from
 * `reportingEngineService`'s own documented fallback where it does not.
 *
 * `ReportPackInput.operatingProfit` is optional, so `undefined` is
 * type-reachable. One side of the pack used to record that as
 * null-with-a-reason and the other as this fallback, against the same source
 * — which throws in `assertConsistent()` and takes the whole render with it.
 * One reading, used by every page that shows the line.
 */
export const OPERATING_PROFIT_SOURCE = 'packMetricReads.operatingProfit';

export function operatingProfitOf(f: ReportPackFigures): number {
  return f.operatingProfit ?? f.revenue - f.costOfSales + (f.otherIncome ?? 0) - f.operatingExpenses;
}
