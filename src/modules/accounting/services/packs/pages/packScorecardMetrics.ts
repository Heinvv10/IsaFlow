/**
 * The scorecard's ten metrics in their five lettered groups — which figure
 * each one reads and where it came from — and the lists other pages take off
 * them. Split out of `packScorecard.ts` for the 300-line cap; that file
 * scores the groups and re-exports every export other modules import.
 */
import type { ExtendedRatioResult } from '@/modules/accounting/services/reports/reportingEngineService';
import { marginPct } from '@/modules/accounting/services/reports/marginPct';
import type { PackFigureFormat } from '@/modules/accounting/services/packs/figures/packFigureProvenance';
import type { ReportPackFigures } from '@/modules/accounting/services/reports/reportPackDataService';
import {
  absentComparativeCashFlow,
  absentOperatingCashFlow,
  DEBTOR_DAYS_SOURCE,
  CREDITOR_DAYS_SOURCE,
  DEBT_TO_EQUITY_SOURCE,
  INTEREST_COVER_SOURCE,
  operatingProfitOf,
  readCreditorDays,
  readDebtToEquity,
  readDebtorDays,
  readInterestCover,
  readOverCurrentLiabilities,
  type PackMetricRead,
} from '@/modules/accounting/services/packs/figures/packMetricReads';

/** No turnover-basis reason exists in `calculateExtendedRatios.notMeaningful`
 *  (equity-divided ratios only), so this one names its own. */
const NO_TURNOVER_MARGIN = 'Revenue is not positive, so there is no turnover to take a margin of.';

/** Shared with the highlights strip, which shows two of these same metrics:
 *  one source must have ONE reading or `assertConsistent` throws. */
export type MetricRead = PackMetricRead;

export interface MetricSpec {
  metric: string;
  format: PackFigureFormat;
  /** e.g. 'calculateExtendedRatios.currentRatio' — service call, then field. */
  source: string;
  /** Key into `DEFAULT_KPI_TARGETS`, or absent when this metric has no target. */
  targetKey?: string;
  lowerIsBetter: boolean;
  read: (ratios: ExtendedRatioResult, raw: ReportPackFigures) => MetricRead;
  /** The comparative cell's own read, where another page prints the same
   *  source and the two must word its absence identically — see
   *  `absentComparativeCashFlow`. Its reason is printed as given. */
  readPrior?: (raw: ReportPackFigures, current: ReportPackFigures) => MetricRead;
}

/**
 * What an unclassified chart of accounts costs this pack, in one sentence.
 *
 * Exported because page 12's caveat says the same thing about the same fact,
 * and the pack must not describe one condition two ways.
 */
/** Reached only if the engine nulls the cycle without recording why. */
const CYCLE_NOT_STATED = 'The cash conversion cycle could not be stated on these figures.';

/**
 * WHY THERE IS NO CYCLE, IN THE WORDS THE ROW ABOVE IT ALREADY USES.
 *
 * The engine states no cash conversion cycle where one of the day counts it
 * is built from has no base. It used to: on a comparative period with
 * negative revenue it added a negative debtor-days figure to the other two
 * and printed the sum. The day count that failed is on this same scorecard
 * with its own reason, so the cycle takes that reason verbatim — one lettered
 * note for the two rows rather than a second sentence saying the same thing.
 */
function cycleNotStated(r: ExtendedRatioResult, raw: ReportPackFigures): PackMetricRead {
  const debtor = readDebtorDays(r, raw);
  if (debtor.value === null) return debtor;
  const creditor = readCreditorDays(r, raw);
  if (creditor.value === null) return creditor;
  return { value: null, unavailable: r.notMeaningful.cashConversionCycle ?? CYCLE_NOT_STATED };
}

export const NO_INVENTORY_CLASSIFIED =
  'No inventory could be identified in the chart of accounts, so the cash conversion cycle cannot be computed.';

export const GROUPS: ReadonlyArray<{ letter: string; name: string; metrics: MetricSpec[] }> = [
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
        // R-P44, AND WHAT CHANGED. The figure set once carried no interest
        // expense, and the engine's cover on a missing input was an artefact
        // zero that told a director "cannot service debt from earnings"
        // falsely — so this row refused to state it. The set now carries the
        // ledger's interest, the engine states no cover without it and says
        // why, and this row prints what the engine gives. No target: unscored.
        metric: 'Interest cover',
        format: 'ratio',
        source: INTEREST_COVER_SOURCE,
        lowerIsBetter: false,
        read: readInterestCover,
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
        // The cash page prints this source too: both word its absence
        // through `packMetricReads`.
        read: (_r, raw) =>
          raw.operatingCashFlow === undefined
            ? { value: null, unavailable: absentOperatingCashFlow(raw), notRecorded: true }
            : { value: raw.operatingCashFlow },
        readPrior: (raw, current) =>
          raw.operatingCashFlow === undefined
            ? { value: null, unavailable: absentComparativeCashFlow(raw, current), notRecorded: true }
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
                notRecorded: true,
              }
            : r.cashConversionCycle === null ? cycleNotStated(r, raw) : { value: r.cashConversionCycle },
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

/** Every metric name page 9 can print, in print order.
 *
 *  Exported for `packDisownedBases`' coverage test: that table is keyed on
 *  these strings and an unknown key fails open, so a rename here would
 *  silently drop a row's disowned-base qualification. It is a red test now.
 */
export const SCORECARD_METRICS: readonly string[] =
  GROUPS.flatMap((g) => g.metrics.map((m) => m.metric));
