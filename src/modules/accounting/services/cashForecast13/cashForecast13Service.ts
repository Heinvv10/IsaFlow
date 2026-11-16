/**
 * `getCashForecast13`: reads every source of the 13-week cash forecast for one company and runs the engine.
 * Every reader is company-scoped and runs in its own savepoint (guardedSource): a source the database
 * cannot read becomes a `source_unavailable` warning and the forecast goes on without it; any other error
 * propagates. Sources run one after another — savepoints on one connection nest, they do not run in parallel.
 *
 * Opening cash is the one source the forecast cannot do without: when it cannot be read the service refuses
 * with `CashForecastUnavailableError` (the route answers 503) rather than forecasting from zero (review L5).
 *
 * Manual items and overrides arrive with PR 2 (their tables); until then the engine gets none. The pay day
 * setting also arrives with PR 2; until then it is the 25th.
 */
import { getCashBalance } from '@/modules/accounting/services/bank/cashBalanceService';
import { runEngine } from './engine';
import { guardedSource } from './guardedSource';
import { toCents } from './lines';
import { BUDGET_REFUSALS, readBudget } from './readBudget';
import { loanItems } from './readLoans';
import { recurringReceiptItems } from './readRecurring';
import { readPayroll, payrollItems } from './readPayroll';
import { readPayables, readReceivables } from './readReceivables';
import { sarsItems } from './readSars';
import { buildWeeks } from './weeks';
import type { PayDay } from './payDates';
import type { CashForecast13, ForecastWarning, KnownItem, ManualItem, OverdueArSummary, Override } from './types';

export const DEFAULT_PAY_DAY: PayDay = 25;

export interface CashForecast13Options {
  payDay?: PayDay;
  manualItems?: ManualItem[];
  overrides?: Override[];
}

const NO_OVERDUE: OverdueArSummary = { totalCents: 0, beyondHorizonCents: 0, invoiceCount: 0, byBasis: { history: 0, no_history: 0 }, disputedCents: 0 };

/** Opening cash could not be read: a forecast from zero would be meaningless. */
export class CashForecastUnavailableError extends Error {
  readonly code = 'CASH_FORECAST_OPENING_UNAVAILABLE';
  constructor() {
    super('The cash forecast is unavailable: the opening bank balance could not be read. Please try again shortly.');
    this.name = 'CashForecastUnavailableError';
  }
}

export async function getCashForecast13(companyId: string, today: string, opts: CashForecast13Options = {}): Promise<CashForecast13> {
  const weeks = buildWeeks(today);
  const horizonEnd = weeks[weeks.length - 1]!.end;
  const warnings: ForecastWarning[] = [];
  const items: KnownItem[] = [];

  const balance = await guardedSource('cash13_opening', 'opening cash', warnings, () => getCashBalance(companyId, today));
  if (!balance) throw new CashForecastUnavailableError();
  const ar = await guardedSource('cash13_ar', 'customer invoices', warnings, () => readReceivables(companyId, today, horizonEnd, warnings));
  if (ar) items.push(...ar.items);
  items.push(...(await guardedSource('cash13_ap', 'supplier invoices', warnings, () => readPayables(companyId, today, warnings))) ?? []);

  const payroll = await guardedSource('cash13_payroll', 'payroll', warnings, () => readPayroll(companyId));
  if (payroll && !payroll.latest) {
    warnings.push({ code: 'payroll_no_runs', source: 'payroll', message: 'No approved or paid regular monthly pay run: no salaries line and no EMP201' });
  }
  if (payroll?.unsupportedFrequency) {
    warnings.push({ code: 'payroll_frequency_unsupported', source: 'payroll', message: 'Weekly or fortnightly pay runs are not forecast; only monthly runs are' });
  }
  if (payroll) items.push(...payrollItems(payroll, opts.payDay ?? DEFAULT_PAY_DAY, today, horizonEnd, warnings));

  const budget = await guardedSource('cash13_budget', 'budget', warnings, () => readBudget(companyId, today, horizonEnd, warnings), BUDGET_REFUSALS);
  items.push(...(await guardedSource('cash13_sars', 'SARS calendar', warnings, () => sarsItems(companyId, today, horizonEnd, payroll, budget, warnings))) ?? []);
  items.push(...(await guardedSource('cash13_loans', 'loans', warnings, () => loanItems(companyId, today, horizonEnd, warnings))) ?? []);
  items.push(...(await guardedSource('cash13_recurring', 'recurring invoices', warnings, () => recurringReceiptItems(companyId, today, horizonEnd))) ?? []);

  return runEngine({
    today,
    openingCents: toCents(balance.total),
    items,
    budget: budget ? budget.months : null,
    manualItems: opts.manualItems ?? [],
    overrides: opts.overrides ?? [],
    overdueAR: ar ? ar.summary : NO_OVERDUE,
    warnings,
  });
}
