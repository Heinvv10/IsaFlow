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
import { DEFAULT_KPI_TARGETS } from '@/modules/accounting/services/reports/reportPackService';
import {
  PackFigureProvenance,
  type PackFigure,
  type PackFigureFormat,
} from '@/modules/accounting/services/packs/figures/packFigureProvenance';
import type { PackFigureSet } from '@/modules/accounting/services/packs/figures/packFigureSet';
import type { ReportPackFigures } from '@/modules/accounting/services/reports/reportPackDataService';
import { operatingProfitOf } from '@/modules/accounting/services/packs/figures/packMetricReads';
import { GROUPS, type MetricRead, type MetricSpec } from './packScorecardMetrics';
import type { PackScorecardGroup, PackScorecardRow, PackScorecardStatus } from './packPageModel';

/** The metric list itself lives in `packScorecardMetrics.ts`, split out for
 *  the 300-line cap. Re-exported because every existing caller imports these
 *  here. */
export { NO_INVENTORY_CLASSIFIED, liquidityMetricNames, SCORECARD_METRICS } from './packScorecardMetrics';

/** `FinancialData` off the pack's own figure shape — nothing computed here,
 *  only renamed and carried through. Named for its input: `toFinancialData`
 *  is `financialFiguresService`'s, and takes `PeriodFigures`. */
export function packFiguresToFinancialData(f: ReportPackFigures): FinancialData {
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
    // OFF THE LEDGER, AS ON FINANCIAL ANALYSIS — the five inputs
    // `readReportPackInput` reads for the window, all or none. They were read
    // and not handed over, so page 9 said interest expense "is not captured in
    // the pack figure set" of a figure set that carried it. Where the read
    // failed none is set and the engine is told so, which is a different
    // sentence from a ledger that holds none.
    interestExpense: f.interestExpense,
    interestIncome: f.interestIncome,
    employeeCosts: f.employeeCosts,
    employeeCount: f.employeeCount,
    taxExpense: f.taxExpense,
    ledgerInputsNotRead: f.ratioInputsUnavailable,
  };
}

const TARGETS = new Map(DEFAULT_KPI_TARGETS.map((t) => [t.ratioKey, t.target]));

function targetFor(spec: MetricSpec): number | null {
  if (!spec.targetKey) return null;
  return TARGETS.get(spec.targetKey) ?? null;
}

function statusFor(read: MetricRead, target: number | null, lowerIsBetter: boolean): PackScorecardStatus {
  const { value } = read;
  // Missing for want of an input is NOT STATED — interest cover where no
  // interest is recorded; NOT MEANINGFUL is for an undefined base.
  if (value === null) return read.notRecorded ? 'notStated' : 'notMeaningful';
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
  const actualRead = spec.read(ratios, raw);
  const actual = recordFigure(p, spec.source, actualRead, spec.format);

  // R-P42: null only when there is no PRIOR PERIOD at all — a prior period
  // whose own ratio isn't meaningful still gets a `PackFigure` with its own
  // reason, on a distinct source so `assertConsistent` never compares them.
  let prior: PackFigure | null = null;
  if (priorRatios && priorRaw) {
    const read = spec.readPrior?.(priorRaw, raw) ?? spec.read(priorRatios, priorRaw);
    prior = recordFigure(
      p,
      `${spec.source}.prior`,
      read,
      spec.format,
      spec.readPrior === undefined && read.value === null && !actualReasons.has(reasonOf(read)),
    );
  }

  const target = targetFor(spec);
  return {
    metric: spec.metric,
    actual,
    target,
    prior,
    status: statusFor(actualRead, target, spec.lowerIsBetter),
    // R-P43: no per-metric monthly series reaches this function (only
    // `buildHighlightTiles` gets one), so null is honest, not guessed.
    trend: null,
    trendSvg: null,
    bulletSvg: null,
  };
}

export function buildScorecardGroups(set: PackFigureSet, p: PackFigureProvenance): PackScorecardGroup[] {
  const ratios = calculateExtendedRatios(packFiguresToFinancialData(set.current));
  const priorRatios = set.prior ? calculateExtendedRatios(packFiguresToFinancialData(set.prior)) : null;

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

