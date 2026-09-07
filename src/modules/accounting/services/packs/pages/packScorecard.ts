/**
 * The board pack's curated scorecard: ten metrics in five lettered groups —
 * never the forty-ratio grid `calculateExtendedRatios` can produce, which is
 * exactly the CSV-like dump this pack was rejected for shipping (spec §4.A
 * page 9).
 *
 * Nothing here computes a ratio. `calculateExtendedRatios` and `marginPct`
 * own every number; this file only selects which ten to show, scores them
 * against `DEFAULT_KPI_TARGETS` (R-P33: imported from `reportPackService`,
 * never copied — a second copy is how a target silently diverges), and
 * records where each figure came from.
 *
 * A ratio divided by non-positive equity is `notMeaningful` with a null
 * value, read from `calculateExtendedRatios`'s own `notMeaningful` map — an
 * insolvent company's negative debt-to-equity would otherwise score as the
 * healthiest possible reading under `lowerIsBetter` (AN-07).
 */

import {
  calculateExtendedRatios,
  type ExtendedRatioResult,
  type FinancialData,
} from '@/modules/accounting/services/reports/reportingEngineService';
import { marginPct } from '@/modules/accounting/services/reports/marginPct';
import { DEFAULT_KPI_TARGETS } from '@/modules/accounting/services/reports/reportPackService';
import {
  PackFigureProvenance,
  type PackFigure,
  type PackFigureFormat,
} from '@/modules/accounting/services/packs/figures/packFigureProvenance';
import type { PackFigureSet } from '@/modules/accounting/services/packs/figures/packFigureSet';
import type { ReportPackFigures } from '@/modules/accounting/services/reports/reportPackDataService';
import {
  DEBTOR_DAYS_SOURCE,
  DEBT_TO_EQUITY_SOURCE,
  operatingProfitOf,
  readDebtToEquity,
  readDebtorDays,
  readOverCurrentLiabilities,
  type PackMetricRead,
} from '@/modules/accounting/services/packs/figures/packMetricReads';
import type { PackScorecardGroup, PackScorecardRow, PackScorecardStatus } from './packPageModel';

/** No turnover-basis reason exists in `calculateExtendedRatios.notMeaningful`
 *  (equity-divided ratios only), so this one names its own. */
const NO_TURNOVER_MARGIN = 'Revenue is not positive, so there is no turnover to take a margin of.';

/** `FinancialData` off the pack's own figure shape — nothing computed here,
 *  only renamed and carried through. */
export function toFinancialData(f: ReportPackFigures): FinancialData {
  return {
    revenue: f.revenue,
    costOfSales: f.costOfSales,
    operatingExpenses: f.operatingExpenses,
    operatingProfit: operatingProfitOf(f),
    otherIncome: f.otherIncome,
    netProfit: f.netProfit,
    totalAssets: f.totalAssets,
    totalLiabilities: f.totalLiabilities,
    totalEquity: f.totalEquity,
    currentAssets: f.currentAssets,
    currentLiabilities: f.currentLiabilities,
    inventory: f.inventory,
    accountsReceivable: f.accountsReceivable,
    accountsPayable: f.accountsPayable,
    cash: f.cash,
    operatingCashFlow: f.operatingCashFlow,
    capitalExpenditure: f.capitalExpenditure,
  };
}

/** Shared with the highlights strip, which shows two of these same metrics:
 *  one source must have ONE reading or `assertConsistent` throws. */
type MetricRead = PackMetricRead;

interface MetricSpec {
  metric: string;
  format: PackFigureFormat;
  /** e.g. 'calculateExtendedRatios.currentRatio' — service call, then field. */
  source: string;
  /** Key into `DEFAULT_KPI_TARGETS`, or absent when this metric has no target. */
  targetKey?: string;
  lowerIsBetter: boolean;
  read: (ratios: ExtendedRatioResult, raw: ReportPackFigures) => MetricRead;
}

const GROUPS: ReadonlyArray<{ letter: string; name: string; metrics: MetricSpec[] }> = [
  {
    letter: 'A',
    name: 'Profitability',
    metrics: [
      {
        metric: 'Gross margin',
        format: 'pct',
        source: 'marginPct.grossMargin',
        targetKey: 'grossProfitMargin',
        lowerIsBetter: false,
        read: (_r, raw) => {
          const grossProfit = raw.revenue - raw.costOfSales;
          const value = marginPct(grossProfit, raw.revenue);
          return value === null
            ? { value: null, unavailable: NO_TURNOVER_MARGIN }
            : { value, basis: { numerator: grossProfit, denominator: raw.revenue } };
        },
      },
      {
        metric: 'Operating margin',
        format: 'pct',
        source: 'marginPct.operatingMargin',
        lowerIsBetter: false,
        read: (_r, raw) => {
          const operatingProfit = operatingProfitOf(raw);
          const value = marginPct(operatingProfit, raw.revenue);
          return value === null
            ? { value: null, unavailable: NO_TURNOVER_MARGIN }
            : { value, basis: { numerator: operatingProfit, denominator: raw.revenue } };
        },
      },
    ],
  },
  {
    letter: 'B',
    name: 'Liquidity',
    metrics: [
      {
        metric: 'Current ratio',
        format: 'ratio',
        source: 'calculateExtendedRatios.currentRatio',
        targetKey: 'currentRatio',
        lowerIsBetter: false,
        read: (r, raw) => readOverCurrentLiabilities(r.currentRatio, raw.currentAssets, raw.currentLiabilities),
      },
      {
        metric: 'Cash ratio',
        format: 'ratio',
        source: 'calculateExtendedRatios.cashRatio',
        lowerIsBetter: false,
        read: (r, raw) => readOverCurrentLiabilities(r.cashRatio, raw.cash, raw.currentLiabilities),
      },
    ],
  },
  {
    letter: 'C',
    name: 'Working capital',
    metrics: [
      {
        metric: 'Debtor days',
        format: 'days',
        source: DEBTOR_DAYS_SOURCE,
        targetKey: 'debtorDays',
        lowerIsBetter: true,
        read: readDebtorDays,
      },
      {
        metric: 'Creditor days',
        format: 'days',
        source: 'calculateExtendedRatios.creditorDays',
        lowerIsBetter: true,
        read: (r) => ({ value: r.creditorDays }),
      },
    ],
  },
  {
    letter: 'D',
    name: 'Leverage',
    metrics: [
      {
        metric: 'Debt-to-equity',
        format: 'ratio',
        source: DEBT_TO_EQUITY_SOURCE,
        targetKey: 'debtToEquity',
        lowerIsBetter: true,
        read: (r, raw) => readDebtToEquity(r, raw),
      },
      {
        // R-P44: the pack captures no interest expense at all, so
        // `interestCoverage`'s `interestExp > 0 ? ... : 0` branch can never
        // fire — its 0 is an artefact, not a measurement, and would tell a
        // director "cannot service debt from earnings" falsely.
        metric: 'Interest cover',
        format: 'ratio',
        source: 'calculateExtendedRatios.interestCoverage',
        lowerIsBetter: false,
        read: () => ({
          value: null,
          unavailable: 'Interest expense is not captured in the pack figure set.',
        }),
      },
    ],
  },
  {
    letter: 'E',
    name: 'Cash flow',
    metrics: [
      {
        metric: 'Operating cash flow',
        format: 'money',
        source: 'packFigureSet.current.operatingCashFlow',
        lowerIsBetter: false,
        read: (_r, raw) =>
          raw.operatingCashFlow === undefined
            ? { value: null, unavailable: 'No operating cash flow figure was captured for this period.' }
            : { value: raw.operatingCashFlow },
      },
      {
        // R-P45: `inventoryCaveat` means "we cannot tell" — inventory is zero
        // because nothing was identified as stock, not because there is none.
        // A CCC computed through that zero reads as fast, favourable cash
        // conversion — wrong the dangerous way, and undetectable downstream.
        metric: 'Cash conversion cycle',
        format: 'days',
        source: 'calculateExtendedRatios.cashConversionCycle',
        lowerIsBetter: true,
        read: (r, raw) =>
          raw.inventoryCaveat !== null
            ? {
                value: null,
                unavailable:
                  'No inventory could be identified in the chart of accounts, so the cash conversion cycle cannot be computed.',
              }
            : { value: r.cashConversionCycle },
      },
    ],
  },
];

const TARGETS = new Map(DEFAULT_KPI_TARGETS.map((t) => [t.ratioKey, t.target]));

function targetFor(spec: MetricSpec): number | null {
  if (!spec.targetKey) return null;
  return TARGETS.get(spec.targetKey) ?? null;
}

function statusFor(value: number | null, target: number | null, lowerIsBetter: boolean): PackScorecardStatus {
  if (value === null) return 'notMeaningful';
  if (target === null) return 'unscored';
  const met = lowerIsBetter ? value <= target : value >= target;
  return met ? 'met' : 'missed';
}

function recordFigure(
  p: PackFigureProvenance,
  source: string,
  read: MetricRead,
  format: PackFigureFormat,
): PackFigure {
  return read.value === null
    ? p.figure(source, null, format, read.unavailable ?? 'This metric could not be computed from the available figures.')
    : p.figure(source, read.value, format, undefined, read.basis);
}

function buildRow(
  spec: MetricSpec,
  ratios: ExtendedRatioResult,
  raw: ReportPackFigures,
  priorRatios: ExtendedRatioResult | null,
  priorRaw: ReportPackFigures | null,
  p: PackFigureProvenance,
): PackScorecardRow {
  const actual = recordFigure(p, spec.source, spec.read(ratios, raw), spec.format);

  // R-P42: null only when there is no PRIOR PERIOD at all — a prior period
  // whose own ratio isn't meaningful still gets a `PackFigure` with its own
  // reason, on a distinct source so `assertConsistent` never compares them.
  const prior =
    priorRatios && priorRaw
      ? recordFigure(p, `${spec.source}.prior`, spec.read(priorRatios, priorRaw), spec.format)
      : null;

  const target = targetFor(spec);
  return {
    metric: spec.metric,
    actual,
    target,
    prior,
    status: statusFor(actual.value, target, spec.lowerIsBetter),
    // R-P43: no per-metric monthly series reaches this function (only
    // `buildHighlightTiles` gets one), so null is honest, not guessed.
    trend: null,
    trendSvg: null,
    bulletSvg: null,
  };
}

export function buildScorecardGroups(set: PackFigureSet, p: PackFigureProvenance): PackScorecardGroup[] {
  const ratios = calculateExtendedRatios(toFinancialData(set.current));
  const priorRatios = set.prior ? calculateExtendedRatios(toFinancialData(set.prior)) : null;

  return GROUPS.map((group) => ({
    letter: group.letter,
    name: group.name,
    rows: group.metrics.map((spec) => buildRow(spec, ratios, set.current, priorRatios, set.prior, p)),
  }));
}
