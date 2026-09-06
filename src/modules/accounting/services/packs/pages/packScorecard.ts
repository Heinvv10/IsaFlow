/**
 * The board pack's curated scorecard: ten metrics in five lettered groups —
 * never the forty-ratio grid `calculateExtendedRatios` can produce, which is
 * exactly the CSV-like dump this pack was rejected for shipping (spec §4.A
 * page 9).
 *
 * Nothing here computes a ratio. `calculateExtendedRatios` and `marginPct`
 * own every number; this file only selects which ten to show, scores them
 * against `DEFAULT_KPI_TARGETS` (R-P33: imported from `reportPackService`,
 * never copied — a second copy is how a target silently diverges between the
 * pack and the KPI screen), and records where each figure came from.
 *
 * A ratio divided by non-positive equity is `notMeaningful` with a null
 * value, read from `calculateExtendedRatios`'s own `notMeaningful` map rather
 * than a reason invented here — an insolvent company's negative debt-to-equity
 * would otherwise score as the healthiest possible reading under
 * `lowerIsBetter` (AN-07).
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
import type { PackScorecardGroup, PackScorecardRow, PackScorecardStatus } from './packPageModel';

/** No turnover-basis reason exists in `calculateExtendedRatios.notMeaningful`
 *  (that map only covers equity-divided ratios), so this one names its own —
 *  a margin on non-positive revenue prints a false-positive percentage
 *  (`marginPct`'s own contract) rather than nothing at all. */
const NO_TURNOVER_MARGIN = 'Revenue is not positive, so there is no turnover to take a margin of.';

/** `FinancialData` off the pack's own figure shape — nothing computed here,
 *  only renamed and carried through. */
function toFinancialData(f: ReportPackFigures): FinancialData {
  return {
    revenue: f.revenue,
    costOfSales: f.costOfSales,
    operatingExpenses: f.operatingExpenses,
    operatingProfit: f.operatingProfit,
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

/** Mirrors `reportingEngineService`'s own operating-line fallback (that
 *  helper is not exported) — other income is above the line, finance cost
 *  and tax are below it. */
function operatingProfitOf(f: ReportPackFigures): number {
  return f.operatingProfit ?? f.revenue - f.costOfSales + (f.otherIncome ?? 0) - f.operatingExpenses;
}

interface MetricRead {
  value: number | null;
  unavailable?: string;
  basis?: { numerator: number; denominator: number };
}

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
        read: (r) => ({ value: r.currentRatio }),
      },
      {
        metric: 'Cash ratio',
        format: 'ratio',
        source: 'calculateExtendedRatios.cashRatio',
        lowerIsBetter: false,
        read: (r) => ({ value: r.cashRatio }),
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
        source: 'calculateExtendedRatios.debtorDays',
        targetKey: 'debtorDays',
        lowerIsBetter: true,
        read: (r) => ({ value: r.debtorDays }),
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
        source: 'calculateExtendedRatios.debtToEquity',
        targetKey: 'debtToEquity',
        lowerIsBetter: true,
        read: (r) =>
          r.debtToEquity === null
            ? {
                value: null,
                unavailable:
                  r.notMeaningful.debtToEquity ?? 'Equity is not positive, so this ratio has no meaning.',
              }
            : { value: r.debtToEquity },
      },
      {
        // R-P44: `ReportPackFigures`/`ReportPackInput` carry no interest-expense
        // field at all, so `calculateExtendedRatios.interestCoverage`'s
        // `interestExp > 0 ? ... : 0` branch can NEVER fire here — the 0 it
        // always returns is an artefact of a field this pack never captures,
        // not a measurement. Printing it would tell a director "this company
        // cannot service its debt from earnings", the opposite of the true
        // story ("we don't know"). Always notMeaningful; never read through
        // to the service's number.
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
        metric: 'Cash conversion cycle',
        format: 'days',
        source: 'calculateExtendedRatios.cashConversionCycle',
        lowerIsBetter: true,
        read: (r) => ({ value: r.cashConversionCycle }),
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

  // R-P42: null only when there is no PRIOR PERIOD at all (`set.prior ===
  // null`) — a prior period whose own ratio is not meaningful still gets a
  // `PackFigure`, carrying its own `unavailable` reason, distinct sources so
  // `assertConsistent` compares actual against actual and prior against prior.
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
    // No per-metric monthly series reaches this function (only the pack's
    // revenue/expense/netProfit trend does, and that is `buildHighlightTiles`'s
    // input, not this one) — R-P43: null is the honest reading, not a
    // direction guessed off actual-vs-prior.
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
