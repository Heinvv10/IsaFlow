// src/modules/accounting/services/afs/managementPackForecast.ts
// The management pack's `cash_flow_forecast` section (Hein 2026-11-16): the budgets P6 three-way budget's
// month-end cash for the fiscal year's primary version, from the pack month to the year end. The figures are
// `getThreeWay`'s (nothing here projects cash); they are read once, at generation, and stored with the pack.
//
// Behind the `budgets_three_way` flag: off, the section is stored exactly as it was before it had a generator
// (no blocks, so every surface prints the "not yet available" sentence), so a company without the flag sees no
// change. Money is integer cents.
import { withSavepoint } from '@/lib/neon';
import { log } from '@/lib/logger';
import { localISODate } from '@/lib/dateUtils';
import { formatCents } from '@/lib/money/formatMoney';
import { hasFeature } from '@/modules/admin/services/featureFlagService';
import { warningText } from '@/components/accounting/budgets/threeWay/warningText';
import { BudgetVersionError } from '../budgets/budgetVersionTypes';
import {
  AssumptionChainError, AssumptionsDocError, CompareInputError, EngineInputError, OpeningUnbalancedError,
} from '../budgets/threeWay/errors';
import { THREE_WAY_FEATURE } from '../budgets/threeWay/routeSchemas';
import { ThreeWayServiceError } from '../budgets/threeWay/serviceErrors';
import { getThreeWay, type ThreeWayView } from '../budgets/threeWay/threeWayViews';
import { fiscalYearForDate } from '../gl/fiscalYearRegistry';
import type { NoteContentBlock } from './afsTypes';
import { capturePackFault } from './managementPackComparison';
import { longDate } from './managementPackStatements';

export interface ForecastMonth { month: string; closingCash: number; belowMinimum: boolean }

export interface ForecastFigures {
  versionId: string;
  versionName: string;
  versionStatus: string;
  fiscalYear: number;
  /** The opening balance sheet's date, and whether it is today's (provisional) rather than the day before the year. */
  asAt: string;
  provisional: boolean;
  minimumCash: number;
  /** The version's months from the pack month to the year end. */
  months: ForecastMonth[];
  /** The lowest closing cash of `months` (the first such month on a tie). */
  lowest: { month: string; closingCash: number } | null;
  balanced: boolean;
  unbalancedMonths: string[];
  warnings: string[];
  warningCodes: string[];
}

export type PackForecast =
  | { kind: 'forecast'; figures: ForecastFigures }
  /** The company lacks the flag. */
  | { kind: 'off' }
  /** The fiscal year has no primary budget version. */
  | { kind: 'none'; fiscalYear: number }
  /** The three-way refused (`fault: false`) or failed (`fault: true`, and the pack is held for review). */
  | { kind: 'unavailable'; fault: boolean };

/** Fixed text: a pack goes to external recipients, and engine messages can carry database text. The real error is logged. */
export const FORECAST_UNAVAILABLE = 'The budgeted cash projection could not be produced for this month.';

export const noVersionSentence = (fiscalYear: number): string =>
  `FY${fiscalYear} has no primary budget version, so there is no budgeted cash projection.`;

/** "2026-12" -> "December 2026". */
const monthLabel = (month: string): string => longDate(`${month}-01`).replace(/^1 /, '');

/** A refusal the three-way answers a request with (P6's 4xx): the month has no projection, the engine is fine. */
function isRefusal(err: unknown): boolean {
  return [BudgetVersionError, ThreeWayServiceError, AssumptionChainError, AssumptionsDocError, OpeningUnbalancedError, EngineInputError, CompareInputError]
    .some((cls) => err instanceof cls);
}

/** The section's figures from one three-way view: the months from `period` on. Pure. */
export function forecastFiguresOf(view: ThreeWayView, period: string): ForecastFigures {
  const minimumCash = view.runway.minimumCash;
  const months = view.cashFlow.direct
    .filter((d) => d.month >= period)
    .map((d) => ({ month: d.month, closingCash: d.closingCash, belowMinimum: d.closingCash < minimumCash }));
  const lowest = months.reduce<ForecastMonth | null>((low, r) => (low === null || r.closingCash < low.closingCash ? r : low), null);
  return {
    versionId: view.version.id, versionName: view.version.name, versionStatus: view.version.status, fiscalYear: view.version.fiscalYear,
    asAt: view.opening.asAt, provisional: view.opening.provisional, minimumCash, months,
    lowest: lowest ? { month: lowest.month, closingCash: lowest.closingCash } : null,
    balanced: view.checks.balanced, unbalancedMonths: view.checks.unbalancedMonths,
    warnings: view.warnings.map(warningText), warningCodes: view.warnings.map((w) => w.code),
  };
}

/**
 * The forecast for a pack month. Never throws: a company without a budget must still get its pack. In a
 * savepoint, so a failed query does not abort the request's transaction the pack is then written in.
 * `today` is the generation date: the three-way's opening is provisional while the year is under way.
 */
export async function loadPackForecast(companyId: string, period: string, periodEnd: string, today: string = localISODate()): Promise<PackForecast> {
  try {
    return await withSavepoint('mgmt_pack_forecast', async (): Promise<PackForecast> => {
      if (!(await hasFeature(companyId, THREE_WAY_FEATURE))) return { kind: 'off' };
      const { fiscalYear } = await fiscalYearForDate(companyId, periodEnd);
      let view: ThreeWayView;
      try {
        view = await getThreeWay(companyId, { fiscalYear }, today);
      } catch (err) {
        if (err instanceof BudgetVersionError && err.code === 'BUDGET_VERSION_NOT_FOUND') return { kind: 'none', fiscalYear };
        throw err;
      }
      return { kind: 'forecast', figures: forecastFiguresOf(view, period) };
    });
  } catch (err) {
    const refusal = isRefusal(err);
    const fields = { companyId, period, errorClass: err instanceof Error ? err.name : typeof err, error: err instanceof Error ? err.message : String(err) };
    if (refusal) log.warn('management pack: the three-way budget refused the pack month', fields, 'managementPackForecast');
    else {
      log.error('management pack: the three-way budget failed; the forecast section prints the unavailable sentence', fields, 'managementPackForecast');
      capturePackFault(err, companyId);
    }
    return { kind: 'unavailable', fault: !refusal };
  }
}

/** The section's blocks. `off` has none: the viewers print the sentence the section always printed. */
export function forecastBlocks(f: PackForecast): NoteContentBlock[] {
  if (f.kind === 'off') return [];
  if (f.kind === 'none') return [{ type: 'paragraph', text: noVersionSentence(f.fiscalYear) }];
  if (f.kind === 'unavailable') return [{ type: 'paragraph', text: FORECAST_UNAVAILABLE }];
  const x = f.figures;
  const min = formatCents(x.minimumCash);
  const blocks: NoteContentBlock[] = [
    { type: 'heading', level: 3, text: 'Budgeted month-end cash' },
    {
      type: 'paragraph',
      text: `From the ${x.versionName} budget (${x.versionStatus}), FY${x.fiscalYear}, on opening balances as at ${longDate(x.asAt)}${x.provisional ? ' (provisional)' : ''}.`,
    },
    {
      type: 'table',
      headers: ['Month', 'Closing cash', 'Minimum cash', 'Below minimum'],
      rows: x.months.map((r) => [monthLabel(r.month), formatCents(r.closingCash), min, r.belowMinimum ? 'Yes' : 'No']),
    },
  ];
  if (x.lowest) {
    const below = x.lowest.closingCash < x.minimumCash ? `, below the minimum of ${min}` : '';
    blocks.push({ type: 'paragraph', text: `The lowest month-end cash is ${formatCents(x.lowest.closingCash)} in ${monthLabel(x.lowest.month)}${below}.` });
  }
  if (!x.balanced) {
    blocks.push({ type: 'paragraph', text: `The budgeted balance sheet does not balance in ${x.unbalancedMonths.map(monthLabel).join(', ')}.` });
  }
  if (x.warnings.length > 0) blocks.push({ type: 'list', items: x.warnings });
  return blocks;
}

/** The data_snapshot stored with the section. `off` stores what the section always stored. */
export function forecastSnapshot(f: PackForecast): Record<string, unknown> {
  switch (f.kind) {
    case 'off': return {};
    case 'none': return { kind: 'none', fiscalYear: f.fiscalYear };
    case 'unavailable': return { kind: 'unavailable' };
    case 'forecast': return { kind: 'forecast', ...f.figures };
  }
}
