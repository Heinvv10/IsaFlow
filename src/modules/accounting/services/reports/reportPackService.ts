/**
 * Report Pack Service
 * Assembles ordered report sections for Board, Management, and Monthly packs.
 * Pure business logic — no database dependencies.
 */

import { calculateExtendedRatios, type FinancialData } from './reportingEngineService';
import { buildKPIScorecard, type KPITargetConfig } from './kpiScorecardService';
import { buildProfitWaterfall } from './waterfallDataService';
import { marginPct, marginPct2dp } from './marginPct';
import type { PackSection, PackType, ReportPack, ReportPackInput } from './reportPackTypes';
import { getPackTemplate } from './reportPackTemplates';

export type { PackSection, PackSectionConfig, PackType, ReportPack, ReportPackInput } from './reportPackTypes';
export { getPackTemplate } from './reportPackTemplates';

/**
 * What the commentary says instead of a percentage when turnover is not
 * positive. Prose rather than the pack's row label (`NO_MARGIN_REASON` in
 * packs/packDocument.ts) because it has to finish a sentence, but it states
 * the same fact: there is no margin, not a margin of zero.
 */
export const NO_MARGIN_SENTENCE =
  'There is no meaningful net profit margin on non-positive turnover.';

/**
 * Exported (R-P33) so the board pack's curated scorecard (`packs/pages/packScorecard.ts`)
 * reads the SAME five targets rather than holding its own copy — a second copy
 * of these numbers is how a target silently diverges between the pack and this
 * KPI screen.
 */
export const DEFAULT_KPI_TARGETS: KPITargetConfig[] = [
  { ratioKey: 'grossProfitMargin', target: 35, warningThreshold: 25, criticalThreshold: 15, lowerIsBetter: false },
  { ratioKey: 'netProfitMargin', target: 15, warningThreshold: 10, criticalThreshold: 5, lowerIsBetter: false },
  { ratioKey: 'currentRatio', target: 1.5, warningThreshold: 1.2, criticalThreshold: 1.0, lowerIsBetter: false },
  { ratioKey: 'debtToEquity', target: 0.5, warningThreshold: 1.0, criticalThreshold: 2.0, lowerIsBetter: true },
  { ratioKey: 'debtorDays', target: 30, warningThreshold: 45, criticalThreshold: 60, lowerIsBetter: true },
];

const NO_CASH_FLOW_READ = (activity: string): string =>
  `No ${activity} cash flow figure was read for this period.`;
const DEPENDS_ON_UNREAD_CASH_FLOW =
  'Not stated: it depends on a cash flow figure that was not read for this period.';

/** Why the pack states no free cash flow. */
export const NO_FREE_CASH_FLOW =
  'Not stated: capital expenditure is not captured separately from other investing cash flows.';

/** Why the pack states no operating cash flow ratio. */
export const NO_OPERATING_CASH_FLOW_RATIO =
  'Not stated: no operating cash flow figure was read for this period.';

/**
 * The pack's ratios, with free cash flow marked not meaningful where there is
 * no capital expenditure to take off, and the operating cash flow ratio where
 * there is no operating cash flow to divide — the engine reads that absence
 * as zero and printed 0.00 beside a cash flow section saying nothing was read.
 *
 * `calculateExtendedRatios` computes it as operating cash flow less capital
 * expenditure and reads an absent capex as zero — so it printed 0 while
 * operating cash flow was absent too, and prints OPERATING cash flow under
 * the name "free cash flow" once that figure is carried. Nothing supplies
 * capex: the cash flow statement nets acquisitions against disposals. Marked
 * here, in the engine's own `notMeaningful` map, so the scorecard and the
 * printed ratios read the same reason; the engine itself is shared with
 * surfaces outside the pack and is not changed.
 */
export function packRatios(financialData: FinancialData): ReturnType<typeof calculateExtendedRatios> {
  const ratios = calculateExtendedRatios(financialData);
  const unstated: Record<string, string> = {};
  if (financialData.capitalExpenditure === undefined) unstated.freeCashFlow = NO_FREE_CASH_FLOW;
  if (financialData.operatingCashFlow === undefined) unstated.operatingCashFlowRatio = NO_OPERATING_CASH_FLOW_RATIO;
  // Nulled as well as explained, so no reader can print the stand-in by
  // skipping the reason, and a scorecard target naming either scores it as
  // not meaningful rather than against a zero. The result type keeps
  // `number` for both: the engine's type is shared and is not changed here.
  const nulled = Object.fromEntries(Object.keys(unstated).map((key) => [key, null]));
  return {
    ...ratios,
    ...nulled,
    notMeaningful: { ...ratios.notMeaningful, ...unstated },
  } as ReturnType<typeof calculateExtendedRatios>;
}

function buildSectionData(
  type: string,
  input: ReportPackInput,
  financialData: FinancialData,
): Record<string, unknown> {
  const grossProfit = input.revenue - input.costOfSales;

  switch (type) {
    case 'income_statement': {
      // Every band, so the pack FOOTS. `revenue` and `operatingExpenses` come
      // from the classifier (turnover only; finance cost and tax excluded)
      // while `netProfit` is the full bottom line — so without these two lines
      // Revenue - CoS - OpEx misses Net Profit by exactly otherIncome minus
      // otherExpenses, R341,712.00 on Brightsphere, on a PDF sent to a client.
      const otherIncome = input.otherIncome ?? 0;
      const otherExpenses = input.otherExpenses ?? 0;
      const operatingProfit =
        input.operatingProfit ?? grossProfit + otherIncome - input.operatingExpenses;
      return {
        revenue: input.revenue,
        costOfSales: input.costOfSales,
        grossProfit,
        otherIncome,
        operatingExpenses: input.operatingExpenses,
        operatingProfit,
        otherExpenses,
        netProfit: input.netProfit,
        // NULL, not 0. A margin needs turnover to be a margin OF, and on
        // zero or negative turnover (credit notes exceeding sales) the pack
        // printed "Gross margin 0.0%" — a figure nothing else on the page
        // supports, on a document a director forwards to a bank. The null is
        // carried through packToMargins to PackDocument, where it becomes a
        // row with its reason instead of a percentage.
        grossMargin: marginPct2dp(grossProfit, input.revenue),
        netMargin: marginPct2dp(input.netProfit, input.revenue),
      };
    }

    case 'balance_sheet':
      return {
        currentAssets: input.currentAssets,
        totalAssets: input.totalAssets,
        currentLiabilities: input.currentLiabilities,
        totalLiabilities: input.totalLiabilities,
        totalEquity: input.totalEquity,
        cash: input.cash,
        accountsReceivable: input.accountsReceivable,
        accountsPayable: input.accountsPayable,
      };

    case 'cash_flow': {
      // A FIGURE NOBODY READ IS NOT A FIGURE. Where no operating cash flow was
      // carried this section took it to BE net profit, took investing and
      // financing to be nil, and derived a net movement and an opening
      // balance from the three — a cash flow statement the ledger never
      // produced. The numbers are still emitted, because every reader of
      // this blob requires six of them; `unavailable` names the ones that
      // are stand-ins, and the printed pack prints the reason instead.
      const unavailable: Record<string, string> = {};
      if (input.operatingCashFlow === undefined) unavailable.operatingCashFlow = NO_CASH_FLOW_READ('operating');
      if (input.investingCashFlow === undefined && input.capitalExpenditure === undefined) {
        unavailable.investingCashFlow = NO_CASH_FLOW_READ('investing');
      }
      if (input.financingCashFlow === undefined) unavailable.financingCashFlow = NO_CASH_FLOW_READ('financing');
      if (Object.keys(unavailable).length > 0) {
        unavailable.netCashFlow = DEPENDS_ON_UNREAD_CASH_FLOW;
        unavailable.openingCash = DEPENDS_ON_UNREAD_CASH_FLOW;
      }
      const opCF = input.operatingCashFlow ?? input.netProfit;
      // THE NET INVESTING FLOW WHERE ONE IS CARRIED, capex negated only where
      // it is not. With real operating and financing figures and investing
      // taken from an absent capex, this printed investing as nil and an
      // opening cash wrong by the whole investing flow.
      const invCF = input.investingCashFlow ?? -(input.capitalExpenditure ?? 0);
      const finCF = input.financingCashFlow ?? 0;
      const netCF = opCF + invCF + finCF;
      return {
        operatingCashFlow: opCF,
        investingCashFlow: invCF,
        financingCashFlow: finCF,
        netCashFlow: netCF,
        openingCash: input.cash - netCF,
        closingCash: input.cash,
        unavailable,
      };
    }

    case 'ratios': {
      // Unstated ratios arrive nulled and explained — see `packRatios`.
      return packRatios(financialData) as unknown as Record<string, unknown>;
    }

    case 'kpis': {
      const ratios = packRatios(financialData);
      const scorecard = buildKPIScorecard(ratios, DEFAULT_KPI_TARGETS);
      return { scorecard };
    }

    case 'waterfall': {
      const { steps } = buildProfitWaterfall({
        revenue: input.revenue,
        costOfSales: input.costOfSales,
        grossProfit,
        operatingExpenses: input.operatingExpenses,
        otherIncome: input.otherIncome ?? 0,
        otherExpenses: input.otherExpenses ?? 0,
        netProfit: input.netProfit,
      });
      return { steps };
    }

    case 'trends': {
      // Single-period snapshot — multi-period trends require historical data
      // from the API layer. The two margins are NULL on non-positive turnover
      // for the same reason the income_statement section's are: a margin needs
      // turnover to be a margin OF, and 0 here is a figure the rest of the
      // snapshot does not support. `currentRatio` keeps its 0 — that one is
      // not a margin and no ruling moved it.
      const gm = marginPct2dp(grossProfit, input.revenue);
      const nm = marginPct2dp(input.netProfit, input.revenue);
      const cr = input.currentLiabilities > 0 ? Math.round((input.currentAssets / input.currentLiabilities) * 100) / 100 : 0;
      return {
        currentPeriod: {
          revenue: input.revenue,
          grossProfit,
          netProfit: input.netProfit,
          grossMargin: gm,
          netMargin: nm,
          currentRatio: cr,
        },
      };
    }

    case 'commentary': {
      // The same rule as every other margin on the pack. The sentence used to
      // read "with a net profit margin of 0%" whenever turnover was zero or
      // negative — a claim of break-even on a page showing a loss, in prose a
      // director quotes verbatim.
      const margin = marginPct(input.netProfit, input.revenue);
      const revenue = `R ${input.revenue.toLocaleString('en-ZA')}`;
      return {
        period: input.period,
        companyName: input.companyName,
        summary: margin === null
          ? `${input.companyName} reported revenue of ${revenue}. ${NO_MARGIN_SENTENCE}`
          : `${input.companyName} reported revenue of ${revenue} with a net profit margin of ${Math.round(margin)}%.`,
      };
    }

    default:
      return {};
  }
}

export function buildReportPack(
  type: PackType,
  data: ReportPackInput,
  from: string,
  to: string,
): ReportPack {
  const template = getPackTemplate(type);

  const financialData: FinancialData = {
    revenue: data.revenue,
    costOfSales: data.costOfSales,
    operatingExpenses: data.operatingExpenses,
    // Carried, so the pack's ratios use the same operating line as every other
    // surface rather than re-deriving one without other income.
    operatingProfit: data.operatingProfit,
    otherIncome: data.otherIncome,
    netProfit: data.netProfit,
    totalAssets: data.totalAssets,
    totalLiabilities: data.totalLiabilities,
    totalEquity: data.totalEquity,
    currentAssets: data.currentAssets,
    currentLiabilities: data.currentLiabilities,
    inventory: data.inventory,
    accountsReceivable: data.accountsReceivable,
    accountsPayable: data.accountsPayable,
    cash: data.cash,
    operatingCashFlow: data.operatingCashFlow,
    capitalExpenditure: data.capitalExpenditure,
  };

  const sections: PackSection[] = template.map(config => ({
    type: config.type,
    title: config.title,
    data: buildSectionData(config.type, data, financialData),
  }));

  return {
    type,
    companyName: data.companyName,
    period: `${from} to ${to}`,
    generatedAt: new Date().toISOString(),
    sections,
  };
}
