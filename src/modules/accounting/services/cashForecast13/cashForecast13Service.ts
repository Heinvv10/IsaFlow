/**
 * `getCashForecast13`: reads every source of the 13-week cash forecast for one company and runs the engine.
 * Every reader is company-scoped and runs in its own savepoint (guardedSource): a source the database
 * cannot read becomes a `source_unavailable` warning and the forecast goes on without it; any other error
 * propagates. Sources run one after another — savepoints on one connection nest, they do not run in parallel.
 *
 * Manual items and overrides arrive with PR 2 (their tables); until then the engine gets none. The pay day
 * setting also arrives with PR 2; until then it is the 25th.
 */
import { getCashBalance } from '@/modules/accounting/services/bank/cashBalanceService';
import { runEngine } from './engine';
import { guardedSource } from './guardedSource';
import { toCents } from './lines';
import { readBudget } from './readBudget';
import { loanItems, recurringReceiptItems } from './readLoansRecurring';
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

const NO_OVERDUE: OverdueArSummary = { totalCents: 0, invoiceCount: 0, byBasis: { history: 0, no_history: 0 }, disputedCents: 0 };

export async function getCashForecast13(companyId: string, today: string, opts: CashForecast13Options = {}): Promise<CashForecast13> {
  const weeks = buildWeeks(today);
  const horizonEnd = weeks[weeks.length - 1]!.end;
  const warnings: ForecastWarning[] = [];
  const items: KnownItem[] = [];

  const balance = await guardedSource('cash13_opening', 'opening cash', warnings, () => getCashBalance(companyId, today));
  const ar = await guardedSource('cash13_ar', 'customer invoices', warnings, () => readReceivables(companyId, today));
  if (ar) items.push(...ar.items);
  items.push(...(await guardedSource('cash13_ap', 'supplier invoices', warnings, () => readPayables(companyId, today))) ?? []);

  const payroll = await guardedSource('cash13_payroll', 'payroll', warnings, () => readPayroll(companyId));
  if (payroll && !payroll.latest) {
    warnings.push({ code: 'payroll_no_runs', source: 'payroll', message: 'No approved or paid pay run: no salaries line and no EMP201' });
  }
  if (payroll) items.push(...payrollItems(payroll, opts.payDay ?? DEFAULT_PAY_DAY, today, horizonEnd));

  const budget = await guardedSource('cash13_budget', 'budget', warnings, () => readBudget(companyId, today, horizonEnd, warnings));
  items.push(...(await guardedSource('cash13_sars', 'SARS calendar', warnings, () => sarsItems(companyId, today, horizonEnd, payroll, budget, warnings))) ?? []);
  items.push(...(await guardedSource('cash13_loans', 'loans', warnings, () => loanItems(companyId, today, horizonEnd, warnings))) ?? []);
  items.push(...(await guardedSource('cash13_recurring', 'recurring invoices', warnings, () => recurringReceiptItems(companyId, today, horizonEnd))) ?? []);

  return runEngine({
    today,
    openingCents: balance ? toCents(balance.total) : 0,
    items,
    budget: budget ? budget.months : null,
    manualItems: opts.manualItems ?? [],
    overrides: opts.overrides ?? [],
    overdueAR: ar ? ar.summary : NO_OVERDUE,
    warnings,
  });
}
