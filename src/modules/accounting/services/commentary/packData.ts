/**
 * Assembles the ManagementPackData the draft builder analyses.
 *
 * Same figure source as the pack itself (`getFinancialFigures`) and the same
 * ratio engine, so a commentary sentence cannot quote a number the statement
 * above it does not show. The prior period comes from `priorPeriod`, which maps
 * a whole-calendar-month window onto the same number of months before it.
 */
import {
  getFinancialFigures, toFinancialData, totalEquity, type PeriodFigures,
} from '@/modules/accounting/services/gl/financialFiguresService';
import { calculateExtendedRatios } from '@/modules/accounting/services/reports/reportingEngineService';
import { priorPeriod } from '@/modules/accounting/services/reports/priorPeriod';
import { getCompanyName } from '@/modules/accounting/services/reports/companyName';
import type { ManagementPackData } from '@/modules/accounting/services/reports/aiCommentaryService';
import type { CommentaryPackData } from './commentaryDraft';
import type { SharePackParams } from '@/modules/accounting/services/share/shareParams';

type IncomeStatement = ManagementPackData['incomeStatement'];

function incomeStatementOf(figures: PeriodFigures): IncomeStatement {
  const { period } = figures;
  return {
    revenue: period.revenue,
    costOfSales: period.costOfSales,
    grossProfit: period.grossProfit,
    operatingExpenses: period.operatingExpenses,
    netProfit: period.netProfit,
  };
}

/** A window with no posted movement at all is not a comparative — it is the
 *  absence of one. Returning zeros would have the draft builder announce that
 *  revenue "remained flat", which is a claim about a period nobody traded in. */
function hasActivity(is: IncomeStatement): boolean {
  return is.revenue !== 0 || is.costOfSales !== 0 || is.operatingExpenses !== 0 || is.netProfit !== 0;
}

export async function buildManagementPackData(
  companyId: string, params: SharePackParams,
): Promise<CommentaryPackData> {
  const prior = priorPeriod(params.from, params.to);
  const [figures, priorFigures, name] = await Promise.all([
    getFinancialFigures(companyId, params.from, params.to),
    getFinancialFigures(companyId, prior.start, prior.end),
    getCompanyName(companyId),
  ]);

  const ratios = calculateExtendedRatios(toFinancialData(figures));
  const priorIs = incomeStatementOf(priorFigures);
  const { cumulative } = figures;

  return {
    companyName: name,
    period: `${params.from} to ${params.to}`,
    incomeStatement: incomeStatementOf(figures),
    balanceSheet: {
      totalAssets: cumulative.totalAssets,
      totalLiabilities: cumulative.totalLiabilities,
      equity: totalEquity(figures),
      currentRatio: ratios.currentRatio,
      // NOT `?? 0`. Null means equity is zero or negative and the ratio has no
      // arithmetic meaning; a 0 here would read as "no gearing" for an
      // insolvent company. The draft builder turns the null into an explicit
      // sentence instead, using the reason carried alongside it.
      debtEquityRatio: ratios.debtToEquity,
      debtEquityUnavailableReason: ratios.notMeaningful.debtToEquity,
    },
    priorPeriod: hasActivity(priorIs) ? priorIs : undefined,
    ratios: {
      grossMargin: ratios.grossProfitMargin,
      netMargin: ratios.netProfitMargin,
      currentRatio: ratios.currentRatio,
      quickRatio: ratios.quickRatio,
    },
  };
}
