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
  CREDITOR_DAYS_SOURCE,
  DEBT_TO_EQUITY_SOURCE,
  operatingProfitOf,
  readCreditorDays,
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
    // EBITDA is `ebit + depreciation + amortisation`, and this field was
    // never handed over — so every pack printed an EBITDA row equal to the
    // operating line to the rand. `accountSubtypes` folds amortisation into
    // the same `depreciation_expense` band, so one field carries both.
    depreciation: f.depreciation,
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

/**
 * What an unclassified chart of accounts costs this pack, in one sentence.
 *
 * Exported because page 12's caveat says the same thing about the same fact,
 * and the pack must not describe one condition two ways.
 */
export const NO_INVENTORY_CLASSIFIED =
  'No inventory could be identified in the chart of accounts, so the cash conversion cycle cannot be computed.';

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
        source: CREDITOR_DAYS_SOURCE,
        lowerIsBetter: true,
        read: readCreditorDays,
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
                unavailable: NO_INVENTORY_CLASSIFIED,
              }
            : { value: r.cashConversionCycle },
      },
    ],
  },
];

/**
 * THE LIQUIDITY MEASURES THIS PACK ACTUALLY PRINTS, READ OFF THE SCORECARD.
 *
 * Page 12's inventory caveat has to name them, and twice now it has named
 * them from the author's belief instead. The first wording qualified a QUICK
 * ratio the pack does not publish. Its replacement — written two rounds ago
 * to fix exactly that — read "liquidity is read off the current ratio alone",
 * and the eleventh gate failed it against section B of page 9, which prints
 * the current ratio AND the cash ratio. One false claim traded for another,
 * because both were checked against a memory of the scorecard rather than
 * against the scorecard.
 *
 * So the caveat takes the names from `GROUPS`, which is the same list page 9
 * renders from. Adding a third liquidity metric rewrites the caveat; removing
 * one rewrites it too. There is no wording that can outlive the section it
 * describes.
 */
const LIQUIDITY_GROUP = 'Liquidity';

export function liquidityMetricNames(): string[] {
  return GROUPS.filter((group) => group.name === LIQUIDITY_GROUP)
    .flatMap((group) => group.metrics.map((metric) => metric.metric));
}

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

/**
 * A REASON WRITTEN FOR ONE PERIOD, PRINTED UNDER A CELL FROM ANOTHER.
 *
 * Sheet 9's footnote b read "Revenue is not positive, so days of sales
 * outstanding cannot be measured" on a page whose Debtor days row prints
 * 213 days, on revenue of 99. Both are true and neither sentence says so: the
 * reason was computed for the PRIOR period, where revenue really is nil, and
 * `MetricSpec.read` writes every reason in the unqualified present tense
 * because it does not know which column it is answering for.
 *
 * Same class as `PackKpiDeltaAbsence` — an absence explanation printed beside
 * the figure whose absence it does not explain — and the fix is the same
 * shape: the CELL states which period its reason is about, since the cell is
 * the thing that knows. It is a prefix rather than a rewrite because the
 * reasons are ordinary sentences a later author will reword, and a rewrite
 * that parses them would silently stop working when one of them changed.
 *
 * ONLY WHERE THE CURRENT PERIOD IS NOT SAYING IT TOO, AND THAT IS NOT A
 * SAVING — IT IS THE RULE. `NotMeaningfulNotes` prints one note per DISTINCT
 * sentence, so prefixing a sentence the actual column already carries splits
 * one note into two that say the same thing about the same measure. On
 * Brightsphere — a company whose revenue is negative in both periods, so most
 * reasons hold in both — that doubled the note block under the scorecard and
 * took the page to 264.9mm on a 255mm sheet: `fitPageToBox` refused the whole
 * pack, and the company could not print a board pack at all. A reason that is
 * true of both periods needs no period stated, because the unqualified present
 * tense is not wrong about either; the prefix is for the reason that is true
 * of the comparative alone, which is the case the defect was about.
 */
const PRIOR_PERIOD_PREFIX = 'In the comparative period: ';

const DEFAULT_REASON = 'This metric could not be computed from the available figures.';

function reasonOf(read: MetricRead): string {
  return read.unavailable ?? DEFAULT_REASON;
}

function recordFigure(
  p: PackFigureProvenance,
  source: string,
  read: MetricRead,
  format: PackFigureFormat,
  /** Whether to say which period this reason is about — see
   *  `PRIOR_PERIOD_PREFIX`. False for every actual cell, and for a prior cell
   *  whose sentence the actual column already states. */
  qualifyAsPrior = false,
): PackFigure {
  if (read.value !== null) return p.figure(source, read.value, format, undefined, read.basis);
  const reason = reasonOf(read);
  const stated = qualifyAsPrior
    ? `${PRIOR_PERIOD_PREFIX}${reason.charAt(0).toLowerCase()}${reason.slice(1)}`
    : reason;
  return p.figure(source, null, format, stated);
}

function buildRow(
  spec: MetricSpec,
  ratios: ExtendedRatioResult,
  raw: ReportPackFigures,
  priorRatios: ExtendedRatioResult | null,
  priorRaw: ReportPackFigures | null,
  p: PackFigureProvenance,
  actualReasons: ReadonlySet<string>,
): PackScorecardRow {
  const actual = recordFigure(p, spec.source, spec.read(ratios, raw), spec.format);

  // R-P42: null only when there is no PRIOR PERIOD at all — a prior period
  // whose own ratio isn't meaningful still gets a `PackFigure` with its own
  // reason, on a distinct source so `assertConsistent` never compares them.
  let prior: PackFigure | null = null;
  if (priorRatios && priorRaw) {
    const read = spec.read(priorRatios, priorRaw);
    prior = recordFigure(
      p,
      `${spec.source}.prior`,
      read,
      spec.format,
      read.value === null && !actualReasons.has(reasonOf(read)),
    );
  }

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

  // Every sentence the ACTUAL column states, gathered before any prior cell is
  // written: a prior reason that repeats one of these is left unqualified so
  // the table carries one note rather than two.
  const actualReasons = new Set(
    GROUPS.flatMap((group) => group.metrics)
      .map((spec) => spec.read(ratios, set.current))
      .filter((read) => read.value === null)
      .map(reasonOf),
  );

  return GROUPS.map((group) => ({
    letter: group.letter,
    name: group.name,
    rows: group.metrics.map((spec) =>
      buildRow(spec, ratios, set.current, priorRatios, set.prior, p, actualReasons)),
  }));
}

/** Every metric name page 9 can print, in print order.
 *
 *  Exported for `packDisownedBases`' coverage test: that table is keyed on
 *  these strings and an unknown key fails open, so a rename here would
 *  silently drop a row's disowned-base qualification. It is a red test now.
 */
export const SCORECARD_METRICS: readonly string[] =
  GROUPS.flatMap((g) => g.metrics.map((m) => m.metric));
