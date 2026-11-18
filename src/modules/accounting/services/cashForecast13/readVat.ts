/**
 * VAT201 for the forecast (ruling 2026-11-16), one calendar item at a time:
 *   - a closed period (ended before today): `getVat201Return(start, end)` box 11;
 *   - the open period: box 11 accrued from its start to today, plus the budget's settlement for the period
 *     pro rata to the days still to run (an estimate); no budget → accrued only, flagged;
 *   - a period not yet started: the budget's settlement (an estimate); no budget → no line, flagged.
 * Payable (≥ 0) is paid on the calendar due date (already moved back off weekends and public holidays). A refund is an inflow on the
 * three-way's timing rule (vatSchedule.vatSettleMonth: period end + `refundLagMonths`), dated the last day of
 * that month because the rule is month-grain.
 */
import { getVat201Return } from '@/modules/accounting/services/reports/vat201Return';
import type { ComplianceEvent } from '@/modules/accounting/services/reports/sarsTaxPeriodsService';
import type { VatSettlement } from '@/modules/accounting/services/budgets/threeWay/types';
import { toCents } from './lines';
import { addMonthsToMonth, daysBetween, daysInMonth } from './weeks';
import { DEFAULT_REFUND_LAG_MONTHS, type ForecastWarning, type KnownItem } from './types';
import type { BudgetRead } from './readBudget';

export const VAT_LINE = { lineKey: 'sars:vat201', lineLabel: 'SARS VAT201' } as const;

/** The day a refund for a period ending `periodEnd` arrives: the last day of the month `lag` months later. */
export function vatRefundDate(periodEnd: string, lagMonths: number): string {
  const month = addMonthsToMonth(periodEnd.slice(0, 7), lagMonths);
  return `${month}-${String(daysInMonth(month)).padStart(2, '0')}`;
}

function settlementFor(e: ComplianceEvent, budget: BudgetRead | null): VatSettlement | undefined {
  return budget?.vatSettlements.find((s) => s.periodStart === e.periodStart.slice(0, 7) && s.periodEnd === e.periodEnd.slice(0, 7));
}

/** Budgeted net for the part of the period after today (all of it for a period not yet started). */
export function budgetRemainder(e: ComplianceEvent, settlement: VatSettlement, today: string): number {
  if (e.periodStart > today) return settlement.net;
  const periodDays = daysBetween(e.periodStart, e.periodEnd) + 1;
  const left = Math.max(0, daysBetween(today, e.periodEnd));
  return Math.round((settlement.net * left) / periodDays);
}

/** Net VAT for the event (liability-positive cents), whether it is an estimate, and its flags; null = no line. */
async function netFor(companyId: string, e: ComplianceEvent, today: string, budget: BudgetRead | null): Promise<{ net: number; estimate: boolean; flags: string[] } | null> {
  if (e.periodEnd < today) {
    return { net: toCents((await getVat201Return(companyId, e.periodStart, e.periodEnd)).field11_vatPayableOrRefundable), estimate: false, flags: [] };
  }
  const settlement = settlementFor(e, budget);
  const accrued = e.periodStart <= today ? toCents((await getVat201Return(companyId, e.periodStart, today)).field11_vatPayableOrRefundable) : 0;
  if (!settlement) return e.periodStart <= today ? { net: accrued, estimate: true, flags: ['vat_no_budget'] } : null;
  return { net: accrued + budgetRemainder(e, settlement, today), estimate: true, flags: [] };
}

export async function vatItem(
  companyId: string, e: ComplianceEvent, today: string, budget: BudgetRead | null, warnings: ForecastWarning[],
): Promise<KnownItem | null> {
  const r = await netFor(companyId, e, today, budget);
  if (r?.flags.includes('vat_no_budget') || !r) {
    warnings.push({ code: 'vat_no_budget', source: 'vat201', message: `${e.description}: no budget for the rest of the period; ${r ? 'VAT accrued to date only' : 'no line'}` });
  }
  if (!r || r.net === 0) return null;
  const refund = r.net < 0;
  return {
    ...VAT_LINE, category: 'sars',
    date: refund ? vatRefundDate(e.periodEnd, budget?.refundLagMonths ?? DEFAULT_REFUND_LAG_MONTHS) : e.dueDate,
    amountCents: -r.net, ref: `VAT201:${e.periodStart}:${e.periodEnd}`,
    refLabel: `${e.description}${refund ? ' (refund)' : ''}`,
    estimate: r.estimate, flags: r.flags,
  };
}
