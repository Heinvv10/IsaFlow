/**
 * The three-way budget for the forecast (ruling 2026-11-16): the PRIMARY version of each financial year the
 * 13 weeks touch (`getThreeWay`, budgets/threeWay/threeWayViews.ts), behind the `budgets_three_way` flag.
 * Gives the direct cash flow per month (the budget fill), the VAT settlements (the open VAT period's
 * remainder), the IRP6 events and the VAT refund lag.
 *
 * A year with no primary version, or one the three-way refuses to run (its typed refusals: an unbalanced
 * opening, a broken scenario chain, …), is left out with a warning — a budget problem is not a reason to
 * withhold the known cash. Any other error propagates; a database error is the caller's guardedSource's.
 */
import { withSavepoint } from '@/lib/neon';
import { hasFeature } from '@/modules/admin/services/featureFlagService';
import { fiscalYearForDate } from '@/modules/accounting/services/gl/fiscalYearRegistry';
import { BudgetVersionError } from '@/modules/accounting/services/budgets/budgetVersionTypes';
import { getThreeWay, type ThreeWayView } from '@/modules/accounting/services/budgets/threeWay/threeWayViews';
import { THREE_WAY_FEATURE } from '@/modules/accounting/services/budgets/threeWay/routeSchemas';
import {
  AssumptionChainError, AssumptionsDocError, EngineInputError, OpeningUnbalancedError,
} from '@/modules/accounting/services/budgets/threeWay/errors';
import { ThreeWayServiceError } from '@/modules/accounting/services/budgets/threeWay/serviceErrors';
import type { TaxEvent, VatSettlement } from '@/modules/accounting/services/budgets/threeWay/types';
import type { BudgetMonth, ForecastWarning } from './types';

/** The refund lag the three-way assumes when no budget says otherwise (assumptionsDefaults.ts). */
export const DEFAULT_REFUND_LAG_MONTHS = 1;

export interface BudgetRead {
  months: BudgetMonth[];
  vatSettlements: VatSettlement[];
  taxEvents: TaxEvent[];
  refundLagMonths: number;
}

const isRefusal = (err: unknown) => err instanceof BudgetVersionError || err instanceof ThreeWayServiceError
  || err instanceof AssumptionChainError || err instanceof AssumptionsDocError || err instanceof OpeningUnbalancedError
  || err instanceof EngineInputError;

async function runYear(companyId: string, fiscalYear: number, today: string, warnings: ForecastWarning[]): Promise<ThreeWayView | null> {
  try {
    return await withSavepoint('cash13_budget_year', () => getThreeWay(companyId, { fiscalYear }, today));
  } catch (err) {
    if (!isRefusal(err)) throw err;
    const none = err instanceof BudgetVersionError && err.code === 'BUDGET_VERSION_NOT_FOUND';
    warnings.push(none
      ? { code: 'budget_no_primary', source: 'budget', message: `FY${fiscalYear} has no primary budget version; no budget estimate for its months` }
      : { code: 'budget_unavailable', source: 'budget', message: `The FY${fiscalYear} budget could not be run: ${(err as Error).message}` });
    return null;
  }
}

/** null when the flag is off or no year has a usable primary version (the warnings say which). */
export async function readBudget(companyId: string, today: string, horizonEnd: string, warnings: ForecastWarning[]): Promise<BudgetRead | null> {
  if (!(await hasFeature(companyId, THREE_WAY_FEATURE))) {
    warnings.push({ code: 'budget_flag_off', source: 'budget', message: 'The three-way budget is not enabled for this company; no budget estimates' });
    return null;
  }
  const years = [...new Set([(await fiscalYearForDate(companyId, today)).fiscalYear, (await fiscalYearForDate(companyId, horizonEnd)).fiscalYear])];
  const out: BudgetRead = { months: [], vatSettlements: [], taxEvents: [], refundLagMonths: DEFAULT_REFUND_LAG_MONTHS };
  let any = false;
  for (const fy of years) {
    const view = await runYear(companyId, fy, today, warnings);
    if (!view) continue;
    if (!any) out.refundLagMonths = view.assumptions.resolved.vat.refundLagMonths.value;
    any = true;
    for (const m of view.cashFlow.direct) {
      if (m.month < today.slice(0, 7) || m.month > horizonEnd.slice(0, 7)) continue;
      out.months.push({ month: m.month, customerReceipts: m.direct.cash_received_from_customers, supplierPayments: m.direct.cash_paid_to_suppliers });
    }
    out.vatSettlements.push(...view.vatSettlements);
    out.taxEvents.push(...view.taxEvents);
  }
  return any ? out : null;
}
