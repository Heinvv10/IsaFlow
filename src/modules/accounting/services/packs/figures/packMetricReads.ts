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

/**
 * `creditorDays` is payables over COST OF SALES. `safeDiv` returns 0 on a
 * zero denominator, so a company with no cost of sales printed `0 days`
 * against R5 792k of current liabilities — the one figure on Brightsphere's
 * scorecard that looked like a measurement and was an artefact of the guard,
 * on a page where every other unavailable metric states a reason.
 *
 * Zero creditor days says the company pays on the day it buys. Nothing on
 * those figures says that.
 */
export const CREDITOR_DAYS_SOURCE = 'calculateExtendedRatios.creditorDays';

export function readCreditorDays(ratios: ExtendedRatioResult, raw: ReportPackFigures): PackMetricRead {
  if (raw.costOfSales <= 0) {
    return {
      value: null,
      unavailable: 'Cost of sales is not positive, so days of purchases outstanding cannot be measured.',
    };
  }
  return { value: ratios.creditorDays };
}

export const DEBT_TO_EQUITY_SOURCE = 'calculateExtendedRatios.debtToEquity';

/**
 * The engine already refuses this ratio on non-positive equity (AN-07) and
 * states its own reason; that reason is read, never re-worded here.
 *
 * The basis is the pair the engine divided — liabilities over equity — so the
 * integrity gate can recompute the printed ratio (I-1). A ratio that prints a
 * number and cannot say which two figures produced it is exactly the shape
 * the gate refuses on the money side, and there is no reason a leverage
 * multiple should be held to a lower standard than a margin. Equity is
 * non-zero on this branch by construction: `debtToEquity` is null whenever
 * equity fails the AN-07 basis test.
 */
export function readDebtToEquity(ratios: ExtendedRatioResult, raw: ReportPackFigures): PackMetricRead {
  return ratios.debtToEquity === null
    ? {
        value: null,
        unavailable:
          ratios.notMeaningful.debtToEquity ?? 'Equity is not positive, so this ratio has no meaning.',
      }
    : {
        value: ratios.debtToEquity,
        basis: { numerator: raw.totalLiabilities, denominator: raw.totalEquity },
      };
}

/**
 * The two current-liability ratios, which `safeDiv` reports as 0 when there
 * are no current liabilities at all.
 *
 * That zero is an artefact of the guard, not a measurement: a company owing
 * nothing in the short term has INFINITE liquidity cover, and printing 0.00
 * says the exact opposite — the same defect class as R-P44's negative debtor
 * days. Reported as unavailable with the reason, which also keeps the gate's
 * recompute honest: a basis over a zero denominator cannot reproduce anything.
 */
const NO_CURRENT_LIABILITIES =
  'There are no current liabilities to cover, so this ratio has no denominator to measure against.';

export function readOverCurrentLiabilities(
  value: number,
  numerator: number,
  currentLiabilities: number,
): PackMetricRead {
  if (currentLiabilities === 0) return { value: null, unavailable: NO_CURRENT_LIABILITIES };
  return { value, basis: { numerator, denominator: currentLiabilities } };
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
